//! 一局无尽模式的完整状态与状态转换（纯函数，时间由调用方传入，方便测试）。
//!
//! 状态（含答案）只存进 `ip_please_endless_runs.state_json`；对外只给 `view_*` 生成的视图。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::generator::{self, Slot, WaveSpec, DAILY_TRAVELERS, RUSH_FACES, WANTED_BLOCK};
use super::model::{is_known_field, Decision, IssueView, PublicEntrant, Secret};
use super::rng::Seed;
use super::scoring::{self, Evidence};

pub const STATE_VERSION: u32 = 1;
pub const MAX_STRIKES: u32 = 3;
/// 旅客出现到判定的最短时间（入场动画 + 递证件都比这长）。
pub const MIN_DECISION_MS: i64 = 1800;
/// 每位旅客最多指认错 6 次，之后锁定（防止穷举字段组合）。
pub const MAX_WRONG_CLAIMS: u32 = 6;
pub const IDLE_MS: i64 = 15 * 60 * 1000;
pub const ENDLESS_MAX_MS: i64 = 4 * 3600 * 1000;
pub const DAILY_MAX_MS: i64 = 60 * 60 * 1000;
pub const RUSH_LEAD_MS: i64 = 2600;
pub const RUSH_FACE_MS: i64 = 2600;
const RUSH_MIN_RT_MS: i64 = 120;
const RUSH_MAX_RT_MS: i64 = 2700;
const CLONE_GRACE_MS: i64 = 300;
/// 时序违规累计到这个次数，这一局不进排行榜。
pub const FLAG_AFTER_VIOLATIONS: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Endless,
    Daily,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Endless => "endless",
            Mode::Daily => "daily",
        }
    }

    pub fn max_duration_ms(self) -> i64 {
        match self {
            Mode::Endless => ENDLESS_MAX_MS,
            Mode::Daily => DAILY_MAX_MS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TravelerState {
    pub entrant_id: String,
    pub t: u32,
    pub issued_at_ms: i64,
    pub public: PublicEntrant,
    pub secret: Secret,
    pub found: Vec<usize>,
    pub wrong_claims: u32,
    pub wrong_before_first_find: u32,
    pub quiz: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WaveState {
    pub wave_id: String,
    pub w: u32,
    pub issued_at_ms: i64,
    pub spec: WaveSpec,
}

// 每局只有一个当前项目，变体大小差异无关紧要
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "item_type", rename_all = "snake_case")]
pub enum Current {
    Traveler(TravelerState),
    Wave(WaveState),
}

/// 上一次判定的结果：同一请求重发时原样返回（幂等）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Last {
    pub item_id: String,
    pub decision: Option<Decision>,
    pub response: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunState {
    pub v: u32,
    pub mode: Mode,
    pub seed: String,
    pub daily_date: Option<String>,
    pub generator_version: i32,
    pub slot: u32,
    pub current: Option<Current>,
    pub last: Option<Last>,
    pub score: i64,
    pub travelers: u32,
    pub processed: u32,
    pub correct: u32,
    pub streak: u32,
    pub best_streak: u32,
    pub strikes: u32,
    pub timing_violations: u32,
    pub end_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepError {
    /// 请求与当前局面不符（重复 / 过期 / 已结束）→ 409
    Conflict,
    /// 太快了（服务器计时）→ 429 + Retry-After
    TooEarly(u64),
    /// 请求内容不合法 → 400
    Invalid,
}

/// 指认请求。
pub enum Claim {
    Fields(Vec<String>),
    Say(usize),
}

impl RunState {
    pub fn new(mode: Mode, seed: &Seed, daily_date: Option<String>) -> Self {
        Self {
            v: STATE_VERSION,
            mode,
            seed: hex::encode(seed),
            daily_date,
            generator_version: generator::GENERATOR_VERSION,
            slot: 0,
            current: None,
            last: None,
            score: 0,
            travelers: 0,
            processed: 0,
            correct: 0,
            streak: 0,
            best_streak: 0,
            strikes: 0,
            timing_violations: 0,
            end_reason: None,
        }
    }

    pub fn seed(&self) -> Seed {
        let mut seed = [0u8; 32];
        if let Ok(bytes) = hex::decode(&self.seed) {
            if bytes.len() == 32 {
                seed.copy_from_slice(&bytes);
            }
        }
        seed
    }

    pub fn ended(&self) -> bool {
        self.end_reason.is_some()
    }

    pub fn flagged(&self) -> bool {
        self.timing_violations >= FLAG_AFTER_VIOLATIONS
    }

    pub fn end(&mut self, reason: &str) {
        if self.end_reason.is_none() {
            self.end_reason = Some(reason.to_string());
            self.current = None;
        }
    }

    /// 已经发出的旅客数（下一位旅客的序号）。
    fn travelers_issued(&self) -> u32 {
        self.slot - self.slot / generator::WAVE_EVERY
    }

    /// 当前 / 下一位旅客的序号（突发规则与通缉令按它显示）。
    pub fn focus_t(&self) -> u32 {
        match &self.current {
            Some(Current::Traveler(traveler)) => traveler.t,
            _ => self.travelers_issued(),
        }
    }

    pub fn next_kind(&self) -> Option<&'static str> {
        if self.ended() {
            return None;
        }
        match &self.current {
            Some(Current::Traveler(_)) => Some("traveler"),
            Some(Current::Wave(_)) => Some("wave"),
            None => match generator::slot(self.slot) {
                Slot::Traveler(_) => Some("traveler"),
                Slot::Wave(_) => Some("wave"),
            },
        }
    }

    /// 是否该结束（闲置 / 超时）。
    pub fn expiry(
        &self,
        started_at_ms: i64,
        last_action_ms: i64,
        now: i64,
    ) -> Option<&'static str> {
        if self.ended() {
            return None;
        }
        if now - last_action_ms >= IDLE_MS {
            Some("idle")
        } else if now - started_at_ms >= self.mode.max_duration_ms() {
            Some("max_duration")
        } else {
            None
        }
    }

    // ———————————————————— 发下一位 ————————————————————

    pub fn next(
        &mut self,
        now: i64,
        new_id: &mut dyn FnMut(&str) -> String,
    ) -> Result<Value, StepError> {
        if self.ended() {
            return Err(StepError::Conflict);
        }
        if self.current.is_none() {
            let seed = self.seed();
            let current = match generator::slot(self.slot) {
                Slot::Traveler(t) => {
                    let entrant_id = new_id("ent");
                    let generated = generator::traveler(&seed, t, &entrant_id);
                    Current::Traveler(TravelerState {
                        entrant_id,
                        t,
                        issued_at_ms: now,
                        public: generated.public,
                        secret: generated.secret,
                        found: Vec::new(),
                        wrong_claims: 0,
                        wrong_before_first_find: 0,
                        quiz: None,
                    })
                }
                Slot::Wave(w) => Current::Wave(WaveState {
                    wave_id: new_id("wave"),
                    w,
                    issued_at_ms: now,
                    spec: generator::wave(&seed, w),
                }),
            };
            self.current = Some(current);
            self.slot += 1;
        }
        Ok(self.view_item().unwrap_or(Value::Null))
    }

    fn traveler_mut(&mut self, entrant_id: &str) -> Result<&mut TravelerState, StepError> {
        match &mut self.current {
            Some(Current::Traveler(traveler)) if traveler.entrant_id == entrant_id => Ok(traveler),
            _ => Err(StepError::Conflict),
        }
    }

    // ———————————————————— 指认 / 测谎 ————————————————————

    pub fn inspect(&mut self, entrant_id: &str, claim: Claim) -> Result<Value, StepError> {
        if self.ended() {
            return Err(StepError::Conflict);
        }
        let traveler = self.traveler_mut(entrant_id)?;
        let claims_left = |t: &TravelerState| MAX_WRONG_CLAIMS.saturating_sub(t.wrong_claims);
        if traveler.wrong_claims >= MAX_WRONG_CLAIMS {
            return Ok(json!({ "match": false, "claims_left": 0, "locked": true }));
        }

        let hit = match &claim {
            Claim::Say(index) => {
                if *index >= traveler.public.intro.len() {
                    return Err(StepError::Invalid);
                }
                if traveler.secret.tell == Some(*index) {
                    traveler
                        .secret
                        .issues
                        .iter()
                        .position(|issue| issue.kind == "tell")
                        .map(|i| (i, vec!["say".to_string()]))
                } else {
                    None
                }
            }
            Claim::Fields(fields) => {
                let ok_shape = match fields.as_slice() {
                    [single] => single.starts_with("xr."),
                    [a, b] => a != b,
                    _ => false,
                };
                if !ok_shape || !fields.iter().all(|f| is_known_field(f) && f != "say") {
                    return Err(StepError::Invalid);
                }
                traveler
                    .secret
                    .issues
                    .iter()
                    .position(|issue| issue.matches(fields))
                    .map(|i| (i, fields.clone()))
            }
        };

        match hit {
            Some((index, fields)) => {
                let fresh = !traveler.found.contains(&index);
                if fresh {
                    traveler.found.push(index);
                }
                let view = traveler.secret.issues[index].view(Some(&fields));
                Ok(json!({
                    "match": true,
                    "issue": view,
                    "new": fresh,
                    "claims_left": claims_left(traveler),
                    "locked": false,
                }))
            }
            None => {
                traveler.wrong_claims += 1;
                if traveler.found.is_empty() {
                    traveler.wrong_before_first_find += 1;
                }
                Ok(json!({
                    "match": false,
                    "claims_left": claims_left(traveler),
                    "locked": traveler.wrong_claims >= MAX_WRONG_CLAIMS,
                }))
            }
        }
    }

    pub fn quiz(&mut self, entrant_id: &str) -> Result<Value, StepError> {
        if self.ended() {
            return Err(StepError::Conflict);
        }
        let traveler = self.traveler_mut(entrant_id)?;
        if traveler.found.is_empty() {
            return Err(StepError::Invalid);
        }
        let exposed = *traveler.quiz.get_or_insert(traveler.secret.liar);
        Ok(json!({ "exposed": exposed }))
    }

    // ———————————————————— 判定 ————————————————————

    fn repeat(&self, item_id: &str, decision: Option<Decision>) -> Result<Value, StepError> {
        match &self.last {
            Some(last) if last.item_id == item_id && last.decision == decision => {
                Ok(last.response.clone())
            }
            _ => Err(StepError::Conflict),
        }
    }

    pub fn decide(
        &mut self,
        entrant_id: &str,
        decision: Decision,
        now: i64,
    ) -> Result<Value, StepError> {
        let pending =
            matches!(&self.current, Some(Current::Traveler(t)) if t.entrant_id == entrant_id);
        if !pending {
            return self.repeat(entrant_id, Some(decision));
        }
        let Some(Current::Traveler(traveler)) = self.current.clone() else {
            return Err(StepError::Conflict);
        };
        let elapsed = now - traveler.issued_at_ms;
        if elapsed < MIN_DECISION_MS {
            return Err(StepError::TooEarly(1));
        }

        let evidence = Evidence {
            found_issue: !traveler.found.is_empty(),
            wrong_before_first_find: traveler.wrong_before_first_find,
            exposed: traveler.quiz == Some(true),
        };
        let streak_before = self.streak;
        let (correct, breakdown) =
            scoring::score(decision, &traveler.secret, evidence, streak_before);

        self.travelers += 1;
        self.processed += 1;
        self.score += breakdown.total;
        if correct {
            self.correct += 1;
            self.streak += 1;
            self.best_streak = self.best_streak.max(self.streak);
        } else {
            self.streak = 0;
            self.strikes += 1;
        }

        let issues: Vec<IssueView> = traveler
            .secret
            .issues
            .iter()
            .map(|issue| issue.view(None))
            .collect();
        let citation = if correct {
            Value::Null
        } else {
            let kind = match decision {
                Decision::Approve if traveler.secret.wanted => "approved_wanted",
                Decision::Approve => "approved_flawed",
                Decision::Deny => "denied_valid",
                Decision::Detain => "detained_valid",
            };
            json!({ "kind": kind, "reason": issues.first() })
        };
        let response = json!({
            "entrant_id": entrant_id,
            "decision": decision,
            "correct": correct,
            "points": breakdown.total,
            "breakdown": breakdown,
            "reveal": {
                "ok": traveler.secret.ok,
                "flaws": traveler.secret.flaws,
                "issues": issues,
                "liar": traveler.secret.liar,
                "fish": traveler.secret.fish,
                "wanted": traveler.secret.wanted,
                "bulletin": traveler.secret.bulletin,
            },
            "citation": citation,
        });

        self.current = None;
        self.last = Some(Last {
            item_id: entrant_id.to_string(),
            decision: Some(decision),
            response: response.clone(),
        });
        if self.strikes >= MAX_STRIKES {
            self.end("strikes");
        } else if self.mode == Mode::Daily && self.travelers >= DAILY_TRAVELERS {
            self.end("shift_done");
        }
        Ok(response)
    }

    // ———————————————————— 波次结算 ————————————————————

    pub fn wave_result(
        &mut self,
        wave_id: &str,
        payload: &Value,
        now: i64,
    ) -> Result<Value, StepError> {
        let pending = matches!(&self.current, Some(Current::Wave(w)) if w.wave_id == wave_id);
        if !pending {
            return self.repeat(wave_id, None);
        }
        let Some(Current::Wave(wave)) = self.current.clone() else {
            return Err(StepError::Conflict);
        };
        let elapsed = now - wave.issued_at_ms;

        let (kind, hits, wrong, missed, points, per_item, violation, citation) = match &wave.spec {
            WaveSpec::Rush { faces } => {
                let min_elapsed = RUSH_LEAD_MS + faces.len() as i64 * 500 - 1000;
                if elapsed < min_elapsed {
                    return Err(StepError::TooEarly(
                        ((min_elapsed - elapsed + 999) / 1000) as u64,
                    ));
                }
                let picks = payload
                    .get("picks")
                    .and_then(Value::as_array)
                    .ok_or(StepError::Invalid)?;
                let mut seen = vec![false; faces.len()];
                let mut picked: Vec<Option<Decision>> = vec![None; faces.len()];
                let mut violation = false;
                for entry in picks {
                    let i = entry
                        .get("i")
                        .and_then(Value::as_u64)
                        .ok_or(StepError::Invalid)? as usize;
                    let pick = entry
                        .get("pick")
                        .and_then(Value::as_str)
                        .and_then(Decision::parse)
                        .filter(|d| *d != Decision::Detain)
                        .ok_or(StepError::Invalid)?;
                    let rt = entry
                        .get("rt_ms")
                        .and_then(Value::as_i64)
                        .ok_or(StepError::Invalid)?;
                    if i >= faces.len() || seen[i] {
                        return Err(StepError::Invalid);
                    }
                    seen[i] = true;
                    if !(RUSH_MIN_RT_MS..=RUSH_MAX_RT_MS).contains(&rt) {
                        violation = true;
                        continue;
                    }
                    picked[i] = Some(pick);
                }
                let hits = faces
                    .iter()
                    .zip(&picked)
                    .filter(|(face, pick)| **pick == Some(face.ok))
                    .count();
                let wrong = picked.iter().filter(|p| p.is_some()).count() - hits;
                let missed = faces.len() - hits - wrong;
                let per_face: Vec<Value> = faces
                    .iter()
                    .zip(&picked)
                    .enumerate()
                    .map(|(i, (face, pick))| json!({ "i": i, "ok": face.ok, "pick": pick, "hit": *pick == Some(face.ok) }))
                    .collect();
                let citation = if wrong > 0 {
                    json!({ "kind": "rush_wrong", "count": wrong })
                } else {
                    Value::Null
                };
                (
                    "rush",
                    hits,
                    wrong,
                    missed,
                    scoring::rush_points(hits, faces.len()),
                    per_face,
                    violation,
                    citation,
                )
            }
            WaveSpec::Clones { runners } => {
                let last_start = runners.iter().map(|c| c.ts_ms).max().unwrap_or(0);
                let min_elapsed = last_start + 200;
                if elapsed < min_elapsed {
                    return Err(StepError::TooEarly(
                        ((min_elapsed - elapsed + 999) / 1000) as u64,
                    ));
                }
                let shots = payload
                    .get("hits")
                    .and_then(Value::as_array)
                    .ok_or(StepError::Invalid)?;
                let mut hit = vec![false; runners.len()];
                let mut violation = false;
                for entry in shots {
                    let i = entry
                        .get("i")
                        .and_then(Value::as_u64)
                        .ok_or(StepError::Invalid)? as usize;
                    let t_ms = entry
                        .get("t_ms")
                        .and_then(Value::as_i64)
                        .ok_or(StepError::Invalid)?;
                    if i >= runners.len() || hit[i] {
                        return Err(StepError::Invalid);
                    }
                    let runner = &runners[i];
                    if t_ms < runner.ts_ms
                        || t_ms > runner.ts_ms + runner.travel_ms() + CLONE_GRACE_MS
                        || t_ms > elapsed
                    {
                        violation = true;
                        continue;
                    }
                    hit[i] = true;
                }
                let hits = hit.iter().filter(|h| **h).count();
                let passed = runners.len() - hits;
                let per_runner: Vec<Value> = hit
                    .iter()
                    .enumerate()
                    .map(|(i, h)| json!({ "i": i, "hit": h }))
                    .collect();
                let citation = if passed > 0 {
                    json!({ "kind": "clones_passed", "count": passed })
                } else {
                    Value::Null
                };
                (
                    "clones",
                    hits,
                    0,
                    passed,
                    scoring::clone_points(hits, runners.len()),
                    per_runner,
                    violation,
                    citation,
                )
            }
        };

        if violation {
            self.timing_violations += 1;
        }
        if kind == "rush" {
            self.processed += RUSH_FACES as u32;
        }
        self.score += points;
        let response = json!({
            "wave_id": wave_id,
            "type": kind,
            "hits": hits,
            "wrong": wrong,
            "missed": missed,
            "points": points,
            "per_item": per_item,
            "citation": citation,
        });
        self.current = None;
        self.last = Some(Last {
            item_id: wave_id.to_string(),
            decision: None,
            response: response.clone(),
        });
        Ok(response)
    }

    // ———————————————————— 视图 ————————————————————

    /// 当前待处理的旅客 / 波次（不含答案；已指认出的破绽一并带回，刷新页面后能恢复）。
    pub fn view_item(&self) -> Option<Value> {
        match self.current.as_ref()? {
            Current::Traveler(traveler) => {
                let found: Vec<IssueView> = traveler
                    .found
                    .iter()
                    .map(|i| traveler.secret.issues[*i].view(None))
                    .collect();
                Some(json!({
                    "item_type": "traveler",
                    "entrant": traveler.public,
                    "progress": {
                        "found": found,
                        "quiz": traveler.quiz,
                        "claims_left": MAX_WRONG_CLAIMS.saturating_sub(traveler.wrong_claims),
                        "locked": traveler.wrong_claims >= MAX_WRONG_CLAIMS,
                    },
                }))
            }
            Current::Wave(wave) => Some(json!({
                "item_type": "wave",
                "wave": match &wave.spec {
                    WaveSpec::Rush { faces } => json!({
                        "wave_id": wave.wave_id,
                        "type": "rush",
                        "lead_ms": RUSH_LEAD_MS,
                        "face_ms": RUSH_FACE_MS,
                        "faces": faces.iter().map(|f| json!({ "person": f.person, "line": f.line })).collect::<Vec<_>>(),
                    }),
                    WaveSpec::Clones { runners } => json!({
                        "wave_id": wave.wave_id,
                        "type": "clones",
                        "gate_x": generator::CLONE_GATE_X,
                        "clones": runners,
                    }),
                },
            })),
        }
    }

    /// 局面摘要（HUD、突发规则、通缉令）。`run_id` 等存储字段由调用方补上。
    pub fn view_summary(&self) -> Value {
        let seed = self.seed();
        let t = self.focus_t();
        let bulletin = if self.ended() {
            None
        } else {
            generator::bulletin_at(&seed, t)
        };
        let wanted = generator::wanted_for(&seed, t / WANTED_BLOCK);
        json!({
            "mode": self.mode,
            "daily_date": self.daily_date,
            "status": if self.ended() { "ended" } else { "active" },
            "end_reason": self.end_reason,
            "score": self.score,
            "travelers": self.travelers,
            "processed": self.processed,
            "correct": self.correct,
            "streak": self.streak,
            "best_streak": self.best_streak,
            "strikes": self.strikes,
            "max_strikes": MAX_STRIKES,
            "multiplier": scoring::multiplier_tenths(self.streak) as f64 / 10.0,
            "travelers_total": if self.mode == Mode::Daily { json!(DAILY_TRAVELERS) } else { Value::Null },
            "next_kind": self.next_kind(),
            "bulletin": bulletin.map(|b| json!({
                "kind": b.kind,
                "args": b.args,
                "remaining": b.remaining_at(t),
            })),
            "wanted": if self.ended() { Value::Null } else { json!({
                "block": wanted.block,
                "photo": wanted.person,
                "name": format!("{}, {}", wanted.surname, wanted.given),
                "crime": wanted.crime,
                "reward": scoring::WANTED_BONUS,
            }) },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::endless::model::Decision::*;

    const SEED: Seed = [5u8; 32];

    fn ids() -> impl FnMut(&str) -> String {
        let mut n = 0;
        move |prefix: &str| {
            n += 1;
            format!("{prefix}_{n:0>22}")
        }
    }

    fn answer(state: &RunState) -> (String, Decision) {
        match &state.current {
            Some(Current::Traveler(t)) => (t.entrant_id.clone(), t.secret.ok[0]),
            _ => panic!("expected traveler"),
        }
    }

    fn wrong_answer(state: &RunState) -> (String, Decision) {
        let (id, ok) = answer(state);
        (id, if ok == Approve { Deny } else { Approve })
    }

    /// 处理当前格子：旅客按 `pick` 判，波次全部放过（不点）。
    fn advance(state: &mut RunState, now: &mut i64, pick: fn(&RunState) -> (String, Decision)) {
        let mut new_id = ids();
        state.next(*now, &mut new_id).unwrap();
        *now += 10_000;
        match state.current.clone() {
            Some(Current::Traveler(_)) => {
                let (id, d) = pick(state);
                state.decide(&id, d, *now).unwrap();
            }
            Some(Current::Wave(w)) => {
                let payload = match w.spec {
                    WaveSpec::Rush { .. } => json!({ "picks": [] }),
                    WaveSpec::Clones { .. } => json!({ "hits": [] }),
                };
                state.wave_result(&w.wave_id, &payload, *now).unwrap();
            }
            None => panic!("nothing issued"),
        }
    }

    #[test]
    fn next_is_idempotent_until_resolved() {
        let mut state = RunState::new(Mode::Endless, &SEED, None);
        let mut new_id = ids();
        let a = state.next(0, &mut new_id).unwrap();
        let b = state.next(5, &mut new_id).unwrap();
        assert_eq!(a, b, "pending item is returned again");
        assert!(!a.to_string().contains("\"secret\""));
    }

    #[test]
    fn decisions_are_timed_and_idempotent() {
        let mut state = RunState::new(Mode::Endless, &SEED, None);
        let mut new_id = ids();
        state.next(0, &mut new_id).unwrap();
        let (id, ok) = answer(&state);
        assert_eq!(state.decide(&id, ok, 500), Err(StepError::TooEarly(1)));
        let first = state.decide(&id, ok, 2_000).unwrap();
        assert_eq!(
            state.decide(&id, ok, 2_100).unwrap(),
            first,
            "same request → same answer"
        );
        let other = if ok == Approve { Deny } else { Approve };
        assert_eq!(state.decide(&id, other, 2_200), Err(StepError::Conflict));
        assert_eq!(
            state.decide("ent_nope", ok, 2_200),
            Err(StepError::Conflict)
        );
        assert_eq!(state.travelers, 1);
        assert_eq!(state.streak, 1);
    }

    #[test]
    fn three_strikes_end_the_run_with_points_kept() {
        let mut state = RunState::new(Mode::Endless, &SEED, None);
        let mut now = 0;
        for _ in 0..3 {
            advance(&mut state, &mut now, answer);
        }
        let banked = state.score;
        assert!(banked > 0);
        while !state.ended() {
            advance(&mut state, &mut now, wrong_answer);
        }
        assert_eq!(state.end_reason.as_deref(), Some("strikes"));
        assert_eq!(state.strikes, 3);
        assert_eq!(state.score, banked, "score never decreases");
        let mut new_id = ids();
        assert_eq!(state.next(now, &mut new_id), Err(StepError::Conflict));
    }

    #[test]
    fn daily_shift_ends_after_forty_travelers() {
        let mut state = RunState::new(Mode::Daily, &SEED, Some("2026-10-24".into()));
        let mut now = 0;
        while !state.ended() {
            advance(&mut state, &mut now, answer);
        }
        assert_eq!(state.end_reason.as_deref(), Some("shift_done"));
        assert_eq!(state.travelers, DAILY_TRAVELERS);
        assert_eq!(state.strikes, 0);
        assert!(state.best_streak >= 20, "streak survives waves");
    }

    #[test]
    fn same_daily_seed_same_travelers() {
        // 两边都判对，但选不同的正确答案（拒绝 / 拘留）：玩家的选择不影响后面的旅客
        let collect = |s: &mut RunState, last_choice: bool| {
            let mut new_id = ids();
            let mut out = Vec::new();
            let mut now = 0;
            for _ in 0..12 {
                s.next(now, &mut new_id).unwrap();
                now += 10_000;
                match s.current.clone().unwrap() {
                    Current::Traveler(t) => {
                        out.push(serde_json::to_string(&t.public.docs).unwrap());
                        let pick = if last_choice {
                            *t.secret.ok.last().unwrap()
                        } else {
                            t.secret.ok[0]
                        };
                        s.decide(&t.entrant_id, pick, now).unwrap();
                    }
                    Current::Wave(w) => {
                        let p = match w.spec {
                            WaveSpec::Rush { .. } => json!({"picks": []}),
                            WaveSpec::Clones { .. } => json!({"hits": []}),
                        };
                        s.wave_result(&w.wave_id, &p, now).unwrap();
                    }
                }
            }
            out
        };
        let mut a = RunState::new(Mode::Daily, &SEED, None);
        let mut b = RunState::new(Mode::Daily, &SEED, None);
        assert_eq!(
            collect(&mut a, false),
            collect(&mut b, true),
            "player choices don't change the sequence"
        );
    }

    fn flawed_with_pairs(state: &mut RunState) -> (String, Vec<String>) {
        let mut new_id = ids();
        let mut now = 0;
        loop {
            state.next(now, &mut new_id).unwrap();
            now += 10_000;
            match state.current.clone().unwrap() {
                Current::Traveler(t) => {
                    if let Some(issue) = t
                        .secret
                        .issues
                        .iter()
                        .find(|i| i.pairs.iter().any(|p| p.len() == 2))
                    {
                        let pair = issue.pairs.iter().find(|p| p.len() == 2).unwrap().clone();
                        return (t.entrant_id.clone(), pair);
                    }
                    state.decide(&t.entrant_id, t.secret.ok[0], now).unwrap();
                }
                Current::Wave(w) => {
                    let p = match w.spec {
                        WaveSpec::Rush { .. } => json!({"picks": []}),
                        WaveSpec::Clones { .. } => json!({"hits": []}),
                    };
                    state.wave_result(&w.wave_id, &p, now).unwrap();
                }
            }
        }
    }

    #[test]
    fn inspect_matches_locks_and_unlocks_quiz() {
        let mut state = RunState::new(Mode::Endless, &SEED, None);
        let (id, pair) = flawed_with_pairs(&mut state);
        assert_eq!(
            state.quiz(&id),
            Err(StepError::Invalid),
            "quiz needs a finding first"
        );
        let miss = state
            .inspect(&id, Claim::Fields(vec!["pp.DOB".into(), "pp.EXP".into()]))
            .unwrap();
        assert_eq!(miss["match"], false);
        assert_eq!(miss["claims_left"], 5);
        let reversed = vec![pair[1].clone(), pair[0].clone()];
        let hit = state.inspect(&id, Claim::Fields(reversed)).unwrap();
        assert_eq!(hit["match"], true);
        assert_eq!(hit["new"], true);
        assert!(hit["issue"]["kind"].is_string());
        let again = state.inspect(&id, Claim::Fields(pair.clone())).unwrap();
        assert_eq!(again["new"], false);
        assert!(state.quiz(&id).is_ok());
        assert_eq!(
            state.inspect(&id, Claim::Fields(vec!["pp.DOB".into()])),
            Err(StepError::Invalid),
            "single-field claims only for x-ray items"
        );
        assert_eq!(
            state.inspect(&id, Claim::Fields(vec!["evil".into(), "pp.DOB".into()])),
            Err(StepError::Invalid)
        );
        for _ in 0..10 {
            let _ = state.inspect(&id, Claim::Fields(vec!["pp.DOB".into(), "pp.SEX".into()]));
        }
        let locked = state.inspect(&id, Claim::Fields(pair)).unwrap();
        assert_eq!(locked["locked"], true);
        assert_eq!(
            locked["match"], false,
            "locked travelers cannot be brute-forced"
        );
    }

    #[test]
    fn rush_timing_and_scoring() {
        let mut state = RunState::new(Mode::Endless, &SEED, None);
        let mut now = 0;
        for _ in 0..8 {
            advance(&mut state, &mut now, answer);
        }
        let mut new_id = ids();
        state.next(now, &mut new_id).unwrap();
        let Some(Current::Wave(wave)) = state.current.clone() else {
            panic!("slot 8 is a wave")
        };
        let WaveSpec::Rush { faces } = &wave.spec else {
            panic!("first wave is rush")
        };
        let picks: Vec<Value> = faces
            .iter()
            .enumerate()
            .map(|(i, f)| json!({ "i": i, "pick": f.ok, "rt_ms": 900 }))
            .collect();
        assert!(matches!(
            state.wave_result(&wave.wave_id, &json!({ "picks": picks }), now + 1000),
            Err(StepError::TooEarly(_))
        ));
        let before = state.score;
        let result = state
            .wave_result(&wave.wave_id, &json!({ "picks": picks }), now + 9000)
            .unwrap();
        assert_eq!(result["hits"], 6);
        assert_eq!(state.score - before, 180);
        assert_eq!(state.timing_violations, 0);
    }

    #[test]
    fn clone_hits_must_fit_the_runner_window() {
        let mut state = RunState::new(Mode::Endless, &SEED, None);
        let mut now = 0;
        for _ in 0..17 {
            advance(&mut state, &mut now, answer);
        }
        let mut new_id = ids();
        state.next(now, &mut new_id).unwrap();
        let Some(Current::Wave(wave)) = state.current.clone() else {
            panic!("slot 17 is a wave")
        };
        let WaveSpec::Clones { runners } = &wave.spec else {
            panic!("second wave is clones")
        };
        let mut hits: Vec<Value> = runners
            .iter()
            .enumerate()
            .take(9)
            .map(|(i, r)| json!({ "i": i, "t_ms": r.ts_ms + 500 }))
            .collect();
        hits.push(json!({ "i": 9, "t_ms": 1 }));
        let result = state
            .wave_result(&wave.wave_id, &json!({ "hits": hits }), now + 20_000)
            .unwrap();
        assert_eq!(result["hits"], 9);
        assert_eq!(state.timing_violations, 1, "impossible timing is flagged");
    }

    #[test]
    fn expiry() {
        let state = RunState::new(Mode::Daily, &SEED, None);
        assert_eq!(state.expiry(0, 0, IDLE_MS - 1), None);
        assert_eq!(state.expiry(0, 0, IDLE_MS), Some("idle"));
        assert_eq!(
            state.expiry(0, DAILY_MAX_MS, DAILY_MAX_MS),
            Some("max_duration")
        );
    }

    #[test]
    fn summary_shows_bulletin_and_wanted() {
        let state = RunState::new(Mode::Endless, &SEED, None);
        let summary = state.view_summary();
        assert_eq!(summary["status"], "active");
        assert_eq!(summary["next_kind"], "traveler");
        assert!(summary["wanted"]["photo"]
            .as_str()
            .unwrap()
            .starts_with('P'));
        assert_eq!(
            summary["bulletin"],
            Value::Null,
            "no bulletin before traveler 10"
        );
    }
}
