//! 无尽模式的旅客 / 波次生成（移植自前端 `randomEntrant` / `randomFishEntrant`，并修掉已知问题）。
//!
//! 第 `t` 位旅客只由 `(seed, t)` 决定（纯函数），玩家怎么操作都不会改变后面的序列：
//! 每日挑战全服同一天看到的旅客完全一样。改动生成逻辑必须提升 `GENERATOR_VERSION`，
//! 并且只在 UTC+8 午夜后上线（否则当天的每日挑战会变）。
//!
//! 相对前端旧实现修掉的问题：
//! - 「蒸馏大军」波次永远不出现：现在按格子交替出现黑话快剪 / 蒸馏大军；
//! - `cat` + `keys` 叠加时只剩一个 X 光物品：现在两个都在；
//! - 叠加缺陷时开场白互相覆盖：`cnip` 与 `hidden` / `tz` / `logins` 不再同时出现；
//! - 黑话快剪的 6 张脸顺序固定可背：现在每波随机。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::model::{Decision, Doc, Issue, Line, Login, Pay, PublicEntrant, Secret};
use super::rng::{stream, Seed, Stream};
use super::tables::{self, Country, COUNTRIES, PORTRAITS};

pub const GENERATOR_VERSION: i32 = 1;
/// 每第 9 格是一个波次。
pub const WAVE_EVERY: u32 = 9;
/// 每日挑战一班 40 位旅客。
pub const DAILY_TRAVELERS: u32 = 40;
/// 通缉令每 40 位旅客换一张。
pub const WANTED_BLOCK: u32 = 40;
pub const RUSH_FACES: usize = 6;
pub const CLONES: usize = 10;
pub const CLONE_GATE_X: i64 = 356;

const FLAWS: [&str; 12] = [
    "tz", "lang", "cnip", "hidden", "virtual", "oregon", "sms", "cat", "keys", "photo", "hosting",
    "logins",
];
const FORBIDDEN: [(&str, &str); 3] = [("cnip", "tz"), ("cnip", "logins"), ("cnip", "hidden")];
const FISH_KINDS: [&str; 5] = ["deep", "rice", "cad", "openai", "whale"];
const BULLETIN_KINDS: [&str; 3] = ["device", "country", "state"];
const MODEL_IDENTITY_PAIRS: [[&str; 2]; 5] = [
    ["md.模型ID", "md.申报"],
    ["md.发行", "md.申报"],
    ["md.申报", "rule.model"],
    ["md.模型ID", "rule.model"],
    ["md.发行", "rule.model"],
];

// ———————————————————— 格子：旅客还是波次 ————————————————————

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    /// 第 t 位旅客（从 0 计）
    Traveler(u32),
    /// 第 w 个波次（从 0 计）
    Wave(u32),
}

pub fn slot(k: u32) -> Slot {
    if (k + 1) % WAVE_EVERY == 0 {
        Slot::Wave((k + 1) / WAVE_EVERY - 1)
    } else {
        Slot::Traveler(k - (k + 1) / WAVE_EVERY)
    }
}

// ———————————————————— 突发规则 ————————————————————

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bulletin {
    pub index: u32,
    pub start: u32,
    pub len: u32,
    pub kind: String,
    pub args: BTreeMap<String, String>,
}

impl Bulletin {
    pub fn remaining_at(&self, t: u32) -> u32 {
        (self.start + self.len).saturating_sub(t)
    }
}

const BULLETIN_LEN: u32 = 5;

fn bulletin_window(seed: &Seed, index: u32, start: u32) -> Bulletin {
    let mut r = stream(seed, "bulletin", u64::from(index));
    let kind = *r.pick(&BULLETIN_KINDS);
    let mut args = BTreeMap::new();
    match kind {
        "device" => {
            args.insert("device".into(), r.pick(&tables::DEVICES).to_string());
        }
        "country" => {
            let foreign: Vec<&Country> = COUNTRIES.iter().filter(|c| c.cc != "US").collect();
            let country = *r.pick(&foreign);
            args.insert("cc".into(), country.cc.into());
            args.insert("country".into(), country.name.into());
        }
        _ => {
            let city = r.pick(COUNTRIES[0].cities);
            args.insert("st".into(), city.st.into());
        }
    }
    Bulletin {
        index,
        start,
        len: BULLETIN_LEN,
        kind: kind.into(),
        args,
    }
}

/// 第 t 位旅客到来时生效的突发规则（第 10–14 位开始，持续 5 位，间隔 9–15 位）。
pub fn bulletin_at(seed: &Seed, t: u32) -> Option<Bulletin> {
    let mut start = 10 + stream(seed, "bulletin_gap", 0).below(5) as u32;
    let mut index = 0;
    loop {
        if t < start {
            return None;
        }
        if t < start + BULLETIN_LEN {
            return Some(bulletin_window(seed, index, start));
        }
        index += 1;
        start += BULLETIN_LEN + 9 + stream(seed, "bulletin_gap", u64::from(index)).below(7) as u32;
    }
}

// ———————————————————— 通缉令 ————————————————————

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Wanted {
    pub block: u32,
    pub person: String,
    pub cc: String,
    /// 通缉令上的真名
    pub surname: String,
    pub given: String,
    /// 混进队伍时护照上的化名
    pub alias_surname: String,
    pub alias_given: String,
    pub crime: u32,
    pub appear_at: u32,
}

pub fn wanted_for(seed: &Seed, block: u32) -> Wanted {
    let mut r = stream(seed, "wanted", u64::from(block));
    let (person, _) = *r.pick(&PORTRAITS);
    let cc = *r.pick(&tables::VALID_CC);
    let country = tables::country(cc);
    let surname = r.pick(country.last).to_string();
    let given = r.pick(country.first).to_string();
    let mut alias_surname = r.pick(country.last).to_string();
    if alias_surname == surname {
        alias_surname =
            country.last[(country.last.iter().position(|s| *s == surname).unwrap_or(0) + 1)
                % country.last.len()]
            .to_string();
    }
    let alias_given = r.pick(country.first).to_string();
    let crime = r.below(tables::WANTED_CRIMES as u64) as u32;
    let appear_at = block * WANTED_BLOCK + 10 + r.below(21) as u32;
    Wanted {
        block,
        person: person.into(),
        cc: cc.into(),
        surname,
        given,
        alias_surname,
        alias_given,
        crime,
        appear_at,
    }
}

// ———————————————————— 旅客 ————————————————————

pub struct Generated {
    pub public: PublicEntrant,
    pub secret: Secret,
}

fn rand_date(r: &mut Stream, y0: i64, y1: i64) -> String {
    format!(
        "{}.{:02}.{:02}",
        r.range(y0, y1),
        r.range(1, 12),
        r.range(1, 28)
    )
}

fn rand_ip(r: &mut Stream, cn: bool) -> String {
    let first = if cn {
        *r.pick(&tables::IP_FIRST_OCTET_CN)
    } else {
        *r.pick(&tables::IP_FIRST_OCTET)
    };
    format!(
        "{first}.{}.{}.{}",
        r.range(1, 254),
        r.range(0, 255),
        r.range(1, 254)
    )
}

fn real_phone(r: &mut Stream, cc: &str, code: &str) -> String {
    if cc == "US" {
        format!("+1 {code}-{}{}-{}", r.range(2, 9), r.digits(2), r.digits(4))
    } else {
        format!("{code} {} {}", r.digits(4), r.digits(4))
    }
}

fn real_pay(r: &mut Stream) -> Pay {
    Pay {
        brand: r.pick(&tables::PAY_BRANDS).to_string(),
        last4: r.digits(4),
        virtual_card: false,
    }
}

fn clock(r: &mut Stream, a: i64, b: i64) -> String {
    format!("{:02}:{:02}", r.range(a, b), r.range(10, 59))
}

/// 「中国 · 北京 · 联通」→「中国 · 北京」
fn loc2(loc: &str) -> String {
    loc.split(" · ").take(2).collect::<Vec<_>>().join(" · ")
}

fn args(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn pairs(list: &[&[&str]]) -> Vec<Vec<String>> {
    list.iter()
        .map(|pair| pair.iter().map(|s| s.to_string()).collect())
        .collect()
}

fn issue(kind: &str, a: BTreeMap<String, String>, p: Vec<Vec<String>>) -> Issue {
    Issue {
        kind: kind.into(),
        args: a,
        pairs: p,
    }
}

/// 同一个立绘池按 24 人一轮不重复地抽；通缉犯那一段里其他人不会长成通缉犯。
fn portrait_for(seed: &Seed, t: u32, wanted: &Wanted) -> &'static str {
    let mut order: Vec<&'static str> = PORTRAITS.iter().map(|(id, _)| *id).collect();
    stream(seed, "pool", u64::from(t / 24)).shuffle(&mut order);
    let i = (t % 24) as usize;
    if order[i] == wanted.person {
        order[(i + 1) % order.len()]
    } else {
        order[i]
    }
}

fn pick_flaws(r: &mut Stream, t: u32) -> Vec<&'static str> {
    let mut pool = FLAWS.to_vec();
    r.shuffle(&mut pool);
    let want = if t >= 12 && r.chance(350) { 2 } else { 1 };
    let mut chosen: Vec<&'static str> = Vec::new();
    for flaw in pool {
        if chosen.len() == want {
            break;
        }
        let clash = chosen.iter().any(|c| {
            FORBIDDEN
                .iter()
                .any(|(a, b)| (a == c && *b == flaw) || (*a == flaw && b == c))
        });
        if !clash {
            chosen.push(flaw);
        }
    }
    chosen
}

/// 证件事实：用于判断是否违反突发规则。
struct Facts {
    cc: String,
    device: String,
    bill: String,
}

fn violates(bulletin: &Bulletin, facts: &Facts) -> Option<Vec<Vec<String>>> {
    let arg = |k: &str| bulletin.args.get(k).map(String::as_str).unwrap_or("");
    match bulletin.kind.as_str() {
        "device" if facts.device == arg("device") => Some(pairs(&[&["dv.设备", "bul.规则"]])),
        "country" if facts.cc == arg("cc") => Some(pairs(&[&["pp.header", "bul.规则"]])),
        "state" if facts.bill.ends_with(&format!(", {}", arg("st"))) => {
            Some(pairs(&[&["ac.账单", "bul.规则"]]))
        }
        _ => None,
    }
}

/// 生成第 t 位旅客。`entrant_id` 由调用方分配（不参与生成，避免影响序列）。
pub fn traveler(seed: &Seed, t: u32, entrant_id: &str) -> Generated {
    let mut r = stream(seed, "traveler", u64::from(t));
    let wanted = wanted_for(seed, t / WANTED_BLOCK);
    if t == wanted.appear_at {
        return fugitive(&mut r, &wanted, t, entrant_id);
    }
    if r.chance(90) {
        let kind = *r.pick(&FISH_KINDS);
        return fish(&mut r, kind, t, entrant_id);
    }
    let bulletin = bulletin_at(seed, t);
    let valid_p = 500u64.saturating_sub(8 * u64::from(t)).max(220);
    let flaws = if r.chance(valid_p) {
        Vec::new()
    } else {
        pick_flaws(&mut r, t)
    };
    // 突发规则生效期间，约一半合规旅客正好撞上临时禁令
    let force = match &bulletin {
        Some(_) if flaws.is_empty() => r.chance(450),
        _ => false,
    };
    let person = portrait_for(seed, t, &wanted);
    regular(
        &mut r,
        RegularSpec {
            t,
            entrant_id,
            person,
            flaws: &flaws,
            bulletin: bulletin.as_ref(),
            force_bulletin: force,
            wanted_person: &wanted.person,
        },
    )
}

struct RegularSpec<'a> {
    t: u32,
    entrant_id: &'a str,
    person: &'a str,
    flaws: &'a [&'static str],
    bulletin: Option<&'a Bulletin>,
    force_bulletin: bool,
    wanted_person: &'a str,
}

fn regular(r: &mut Stream, spec: RegularSpec<'_>) -> Generated {
    let has = |flaw: &str| spec.flaws.contains(&flaw);
    let valid = spec.flaws.is_empty();
    let forced = spec.bulletin.filter(|_| spec.force_bulletin);
    let forced_arg = |k: &str| {
        forced
            .and_then(|b| b.args.get(k))
            .map(String::as_str)
            .unwrap_or("")
    };

    let mut cc = if valid {
        *r.pick(&tables::VALID_CC)
    } else {
        "US"
    };
    match forced.map(|b| b.kind.as_str()) {
        Some("country") => cc = tables::country(forced_arg("cc")).cc,
        Some("state") => cc = "US",
        _ => {}
    }
    let country = tables::country(cc);
    let mut city = r.pick(country.cities);
    if forced.map(|b| b.kind.as_str()) == Some("state") {
        let st = forced_arg("st");
        city = country.cities.iter().find(|c| c.st == st).unwrap_or(city);
    }

    let sex = tables::portrait_sex(spec.person).to_string();
    let surname = r.pick(country.last).to_string();
    let given = r.pick(country.first).to_string();
    let dob = rand_date(r, 1960, 2004);
    let exp = rand_date(r, 2027, 2034);
    let mut photo = spec.person.to_string();
    let mut loc = if cc == "SG" {
        "新加坡".to_string()
    } else {
        format!("{} · {}", country.name, city.name)
    };
    let mut tz = city.tz.to_string();
    let mut lang = country.lang.to_string();
    let mut ip = rand_ip(r, false);
    let mut pay = real_pay(r);
    let mut bill = format!("{}, {}", r.pick(&tables::STREETS), city.st);
    let mut phone = real_phone(r, cc, city.code);
    let mut device = r.pick(&tables::DEVICES).to_string();
    if forced.map(|b| b.kind.as_str()) == Some("device") {
        device = forced_arg("device").to_string();
    }
    let mut net = "home".to_string();
    let voice = r.range(100, 190);
    let mut intro = vec![Line::entrant(r.pick_str(country.hello))];
    let mut xray = Vec::new();
    let mut logins: Option<Vec<Login>> = None;
    let mut issues = Vec::new();
    let mut tell = None;

    for flaw in spec.flaws {
        match *flaw {
            "tz" => {
                tz = "Asia/Shanghai".into();
                issues.push(issue(
                    "tz",
                    args(&[("country", country.name), ("tz", &tz)]),
                    pairs(&[
                        &["pp.header", "dv.时区"],
                        &["dv.归属", "dv.时区"],
                        &["dv.时区", "rule.tz"],
                    ]),
                ));
            }
            "lang" => {
                lang = "zh-CN".into();
                issues.push(issue(
                    "lang",
                    args(&[("country", country.name), ("lang", &lang)]),
                    pairs(&[
                        &["pp.header", "dv.语言"],
                        &["dv.归属", "dv.语言"],
                        &["dv.语言", "rule.tz"],
                    ]),
                ));
            }
            "cnip" => {
                loc = r.pick(&tables::CN_LOCS[..4]).to_string();
                ip = rand_ip(r, true);
                tz = "Asia/Shanghai".into();
                intro = vec![Line::entrant(r.pick_str(&tables::CNIP_HELLO))];
                issues.push(issue(
                    "region",
                    args(&[("loc", &loc)]),
                    pairs(&[&["dv.归属", "rule.region"], &["dv.IP", "rule.region"]]),
                ));
                issues.push(issue(
                    "nationality_ip",
                    args(&[("loc", &loc2(&loc))]),
                    pairs(&[&["pp.header", "dv.归属"]]),
                ));
            }
            "hidden" => {
                let say = r.below(tables::TELL_SAYS.len() as u64) as usize;
                intro = vec![Line::entrant(tables::TELL_SAYS[say])];
                tell = Some(0);
                issues.push(issue(
                    "tell",
                    args(&[("say", &say.to_string())]),
                    Vec::new(),
                ));
            }
            "virtual" => {
                pay.virtual_card = true;
                issues.push(issue(
                    "virtual",
                    BTreeMap::new(),
                    pairs(&[&["ac.付款", "rule.pay"]]),
                ));
            }
            "oregon" => {
                bill = "123 Main St, OR".into();
                issues.push(issue(
                    "oregon",
                    args(&[("city", city.name)]),
                    pairs(&[&["ac.账单", "rule.pay"], &["ac.账单", "dv.归属"]]),
                ));
            }
            "sms" => {
                phone = format!("+1 {}-555-01{}", r.pick(&tables::SMS_AREAS), r.digits(2));
                issues.push(issue(
                    "sms",
                    args(&[("phone", &phone)]),
                    pairs(&[&["ac.手机", "rule.pay"]]),
                ));
            }
            "cat" | "keys" => {
                let key = format!("xr.{flaw}");
                xray.push(key.clone());
                issues.push(issue(
                    &format!("xray_{flaw}"),
                    BTreeMap::new(),
                    vec![vec![key.clone()], vec![key, "rule.xray".into()]],
                ));
            }
            "photo" => {
                let others: Vec<&str> = PORTRAITS
                    .iter()
                    .map(|(id, _)| *id)
                    .filter(|id| *id != spec.person && *id != spec.wanted_person)
                    .collect();
                photo = r.pick(&others).to_string();
                issues.push(issue(
                    "photo",
                    BTreeMap::new(),
                    pairs(&[&["face", "pp.photo"]]),
                ));
            }
            "hosting" => {
                net = "hosting".into();
                issues.push(issue(
                    "hosting",
                    BTreeMap::new(),
                    pairs(&[&["dv.网络", "rule.net"]]),
                ));
            }
            "logins" => {
                let last = loc2(r.pick_str(&tables::CN_LOCS[..7]));
                let rows = vec![
                    Login {
                        ago_days: 0,
                        time: clock(r, 7, 11),
                        loc: last.clone(),
                    },
                    Login {
                        ago_days: 1,
                        time: clock(r, 18, 23),
                        loc: loc2(r.pick_str(&tables::CN_LOCS[..7])),
                    },
                    Login {
                        ago_days: 3,
                        time: clock(r, 12, 22),
                        loc: loc2(r.pick_str(&tables::CN_LOCS[..7])),
                    },
                ];
                logins = Some(rows);
                issues.push(issue(
                    "logins",
                    args(&[("loc", &last)]),
                    pairs(&[&["log.last", "dv.归属"]]),
                ));
            }
            _ => {}
        }
    }

    let logins = logins.unwrap_or_else(|| {
        let home = loc2(&loc);
        vec![
            Login {
                ago_days: 0,
                time: clock(r, 7, 11),
                loc: home.clone(),
            },
            Login {
                ago_days: 1,
                time: clock(r, 18, 23),
                loc: home.clone(),
            },
            Login {
                ago_days: 3,
                time: clock(r, 12, 22),
                loc: home,
            },
        ]
    });

    let facts = Facts {
        cc: cc.to_string(),
        device: device.clone(),
        bill: bill.clone(),
    };
    let mut on_bulletin = false;
    if let Some(bulletin) = spec.bulletin {
        if let Some(p) = violates(bulletin, &facts) {
            on_bulletin = true;
            let mut a = bulletin.args.clone();
            a.insert("rule".into(), bulletin.kind.clone());
            issues.push(issue("bulletin", a, p));
        }
    }

    let flawed = !spec.flaws.is_empty() || on_bulletin;
    let secret = Secret {
        ok: if flawed {
            vec![Decision::Deny, Decision::Detain]
        } else {
            vec![Decision::Approve]
        },
        flaws: spec.flaws.iter().map(|f| f.to_string()).collect(),
        issues,
        tell,
        liar: !spec.flaws.is_empty() && !has("cnip"),
        fish: None,
        wanted: false,
        bulletin: on_bulletin,
    };
    let public = PublicEntrant {
        entrant_id: spec.entrant_id.into(),
        seq: spec.t + 1,
        person: spec.person.into(),
        voice,
        intro,
        primary: "pp".into(),
        docs: vec![
            Doc::Passport {
                key: "pp".into(),
                cc: cc.into(),
                photo,
                surname,
                given,
                dob,
                sex,
                iss: city.en.into(),
                exp,
            },
            Doc::Device {
                key: "dv".into(),
                ip,
                loc,
                tz,
                lang,
                device,
                net,
            },
            Doc::Account {
                key: "ac".into(),
                pay,
                bill,
                phone,
            },
        ],
        logins,
        xray,
    };
    Generated { public, secret }
}

/// 通缉犯：证件全部自洽，只是脸和通缉令上的一样（护照上用的是化名）。
fn fugitive(r: &mut Stream, wanted: &Wanted, t: u32, entrant_id: &str) -> Generated {
    let mut generated = regular(
        r,
        RegularSpec {
            t,
            entrant_id,
            person: &wanted.person,
            flaws: &[],
            bulletin: None,
            force_bulletin: false,
            wanted_person: "",
        },
    );
    // 护照用的是化名：名字对不上通缉令，只有脸一样
    if let Some(Doc::Passport { surname, given, .. }) = generated.public.docs.first_mut() {
        *surname = wanted.alias_surname.clone();
        *given = wanted.alias_given.clone();
    }
    generated.secret = Secret {
        ok: vec![Decision::Deny, Decision::Detain],
        flaws: vec!["wanted".into()],
        issues: vec![issue(
            "wanted",
            BTreeMap::new(),
            pairs(&[&["face", "wt.photo"], &["pp.photo", "wt.photo"]]),
        )],
        tell: None,
        liar: false,
        fish: None,
        wanted: true,
        bulletin: false,
    };
    generated
}

fn fish(r: &mut Stream, kind: &str, t: u32, entrant_id: &str) -> Generated {
    let us = &COUNTRIES[0];
    let city = r.pick(us.cities);
    let mut loc = format!("美国 · {}", city.name);
    let surname = r.pick(&tables::FISH_NAMES).to_string();
    let given = r.pick(&tables::FISH_NAMES).to_string();
    let dob = rand_date(r, 2010, 2020);
    let exp = rand_date(r, 2027, 2034);
    let mut ip = rand_ip(r, false);
    let device = r.pick(&tables::DEVICES).to_string();
    let pay = real_pay(r);
    let bill = format!("{}, {}", r.pick(&tables::STREETS), city.st);
    let phone = real_phone(r, "US", city.code);
    let mut photo = tables::FISH_PERSON.to_string();
    let mut intro = vec![Line::entrant(r.pick_str(&tables::FISH_HELLO))];
    let mut xray = Vec::new();
    let mut issues = Vec::new();
    let mut account = true;
    let mut model = None;

    match kind {
        "deep" => {
            intro = vec![
                Line::with("C", "请说明你的来意。", json!(null)),
                Line::with("E", "正在深度思考中……", json!({ "hold": 1.8 })),
                Line::with("E", "……旅游！我想到答案了！", json!({ "expr": "grin" })),
            ];
        }
        "rice" => {
            xray = vec!["xr.rice".into(), "xr.lunch".into()];
            intro = vec![
                Line::with("C", "为什么 CPU 占用 100%？", json!(null)),
                Line::with("E", "我在认真思考！", json!({ "expr": "grin" })),
            ];
        }
        "cad" => {
            loc = tables::FISH_CAD_LOC.into();
            ip = format!("24.114.{}.{}", r.range(1, 254), r.range(1, 254));
            intro = vec![Line::entrant("加拿大也是北美啊！")];
            issues.push(issue(
                "region",
                args(&[("loc", &loc)]),
                pairs(&[&["dv.归属", "rule.region"], &["dv.IP", "rule.region"]]),
            ));
            issues.push(issue(
                "nationality_ip",
                args(&[("loc", &loc)]),
                pairs(&[&["pp.header", "dv.归属"]]),
            ));
        }
        "openai" => {
            intro = vec![
                Line::entrant("你好，我是美国 OpenAI 模型。"),
                Line::with("C", "请出示证明。", json!(null)),
                Line::entrant("我支持 OpenAI API！"),
                Line::with("C", "那只是接口兼容。", json!(null)),
            ];
            account = false;
            model = Some(Doc::ModelPermit {
                key: "md".into(),
                claim: "OpenAI GPT".into(),
                model_id: "deepseek-chat".into(),
                org: "DeepSeek".into(),
            });
            issues.push(issue(
                "model_identity",
                args(&[("claim", "OpenAI"), ("model_id", "deepseek-chat")]),
                MODEL_IDENTITY_PAIRS
                    .iter()
                    .map(|p| p.iter().map(|s| s.to_string()).collect())
                    .collect(),
            ));
        }
        _ => {
            photo = "FISH_WHALE".into();
            intro = vec![Line::entrant("我这次连证件照都准备好了！本人照片！")];
            issues.push(issue(
                "fish_photo",
                BTreeMap::new(),
                pairs(&[&["face", "pp.photo"]]),
            ));
        }
    }

    let flawed = !issues.is_empty();
    let mut docs = vec![
        Doc::Passport {
            key: "pp".into(),
            cc: "US".into(),
            photo,
            surname,
            given,
            dob,
            sex: "F".into(),
            iss: city.en.into(),
            exp,
        },
        Doc::Device {
            key: "dv".into(),
            ip,
            loc,
            tz: city.tz.into(),
            lang: "en-US".into(),
            device,
            net: "home".into(),
        },
    ];
    if account {
        docs.push(Doc::Account {
            key: "ac".into(),
            pay,
            bill,
            phone,
        });
    }
    if let Some(model) = model {
        docs.push(model);
    }
    Generated {
        public: PublicEntrant {
            entrant_id: entrant_id.into(),
            seq: t + 1,
            person: tables::FISH_PERSON.into(),
            voice: tables::FISH_VOICE,
            intro,
            primary: "pp".into(),
            docs,
            logins: Vec::new(),
            xray,
        },
        secret: Secret {
            ok: if flawed {
                vec![Decision::Deny, Decision::Detain]
            } else {
                vec![Decision::Approve]
            },
            flaws: if flawed {
                vec![format!("fish_{kind}")]
            } else {
                Vec::new()
            },
            issues,
            tell: None,
            liar: false,
            fish: Some(kind.into()),
            wanted: false,
            bulletin: false,
        },
    }
}

// ———————————————————— 波次 ————————————————————

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RushFace {
    pub person: String,
    pub line: String,
    pub ok: Decision,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CloneRunner {
    pub ts_ms: i64,
    pub x0: i64,
    pub y: i64,
    pub v: i64,
}

impl CloneRunner {
    /// 从出发到冲过闸门的毫秒数。
    pub fn travel_ms(&self) -> i64 {
        (CLONE_GATE_X - self.x0) * 1000 / self.v.max(1)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WaveSpec {
    Rush { faces: Vec<RushFace> },
    Clones { runners: Vec<CloneRunner> },
}

/// 第 w 个波次：偶数是黑话快剪，奇数是蒸馏大军。
pub fn wave(seed: &Seed, w: u32) -> WaveSpec {
    let mut r = stream(seed, "wave", u64::from(w));
    if w % 2 == 0 {
        let approves = 2 + r.below(3) as usize;
        let mut deny = tables::RUSH_DENY.to_vec();
        r.shuffle(&mut deny);
        let mut faces: Vec<RushFace> = deny
            .iter()
            .cycle()
            .take(RUSH_FACES - approves)
            .map(|(person, line)| RushFace {
                person: person.to_string(),
                line: line.to_string(),
                ok: Decision::Deny,
            })
            .collect();
        for _ in 0..approves {
            faces.push(RushFace {
                person: r.pick(&PORTRAITS).0.to_string(),
                line: r.pick(&tables::RUSH_APPROVE).to_string(),
                ok: Decision::Approve,
            });
        }
        r.shuffle(&mut faces);
        WaveSpec::Rush { faces }
    } else {
        let runners = (0..CLONES as i64)
            .map(|i| CloneRunner {
                ts_ms: 1600 + i * 600 + r.range(0, 200),
                x0: 226 + (i % 3) * 20,
                y: 104 + (i * 7) % 18,
                v: 30 + r.range(0, 3) * 5,
            })
            .collect();
        WaveSpec::Clones { runners }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    const SEED: Seed = [42u8; 32];

    #[test]
    fn slots_alternate_travelers_and_waves() {
        assert_eq!(slot(0), Slot::Traveler(0));
        assert_eq!(slot(7), Slot::Traveler(7));
        assert_eq!(slot(8), Slot::Wave(0));
        assert_eq!(slot(9), Slot::Traveler(8));
        assert_eq!(slot(17), Slot::Wave(1));
        assert_eq!(slot(26), Slot::Wave(2));
        // 每日挑战 40 位旅客 → 前 44 格里有 4 个波次
        let travelers = (0..44)
            .filter(|k| matches!(slot(*k), Slot::Traveler(_)))
            .count();
        assert_eq!(travelers, 40);
        assert!(matches!(wave(&SEED, 0), WaveSpec::Rush { .. }));
        assert!(matches!(wave(&SEED, 1), WaveSpec::Clones { .. }));
    }

    #[test]
    fn deterministic_per_seed_and_position() {
        let a = traveler(&SEED, 17, "ent_a");
        let b = traveler(&SEED, 17, "ent_b");
        assert_eq!(a.secret, b.secret);
        assert_eq!(a.public.docs, b.public.docs);
        assert_eq!(a.public.intro, b.public.intro);
        let other = traveler(&[43u8; 32], 17, "ent_a");
        assert!(other.public.docs != a.public.docs || other.secret != a.secret);
    }

    #[test]
    fn public_entrant_never_contains_answers() {
        for t in 0..300 {
            let g = traveler(&SEED, t, "ent_x");
            let text = serde_json::to_string(&g.public).unwrap();
            for word in [
                "\"ok\"",
                "\"issues\"",
                "\"liar\"",
                "\"tell\"",
                "\"reason\"",
                "\"react\"",
                "\"wanted\"",
                "\"fish\"",
            ] {
                assert!(!text.contains(word), "{word} leaked in {text}");
            }
        }
    }

    #[test]
    fn fish_rate_and_validity_curve() {
        let n = 4000u32;
        let mut fish = 0;
        let mut approve_early = 0;
        for t in 0..n {
            let g = traveler(&[(t % 251) as u8; 32], t % 3, "e");
            if g.secret.fish.is_some() {
                fish += 1;
            }
            if g.secret.ok.contains(&Decision::Approve) {
                approve_early += 1;
            }
        }
        let rate = f64::from(fish) / f64::from(n);
        assert!((0.06..0.12).contains(&rate), "fish rate {rate}");
        let approve_rate = f64::from(approve_early) / f64::from(n);
        assert!(
            (0.38..0.6).contains(&approve_rate),
            "early approve rate {approve_rate}"
        );
    }

    #[test]
    fn flaw_combinations_and_xray() {
        let mut saw_double = false;
        let mut saw_both_xray = false;
        for s in 0..60u8 {
            for t in 12..200 {
                let g = traveler(&[s; 32], t, "e");
                let flaws = &g.secret.flaws;
                for (a, b) in FORBIDDEN {
                    assert!(
                        !(flaws.iter().any(|f| f == a) && flaws.iter().any(|f| f == b)),
                        "forbidden combo {a}+{b}"
                    );
                }
                if flaws.len() == 2 {
                    saw_double = true;
                }
                if flaws.iter().any(|f| f == "cat") && flaws.iter().any(|f| f == "keys") {
                    saw_both_xray = true;
                    let mut xray = g.public.xray.clone();
                    xray.sort();
                    assert_eq!(xray, vec!["xr.cat".to_string(), "xr.keys".to_string()]);
                }
                if flaws.iter().any(|f| f == "hidden") {
                    assert_eq!(g.secret.tell, Some(0));
                    assert_eq!(g.public.intro.len(), 1);
                }
            }
        }
        assert!(saw_double, "double flaws appear after t >= 12");
        assert!(saw_both_xray, "cat+keys stack keeps both items");
    }

    #[test]
    fn every_flawed_traveler_has_a_findable_issue() {
        for t in 0..400 {
            let g = traveler(&SEED, t, "e");
            if g.secret.ok.contains(&Decision::Approve) {
                assert!(
                    g.secret.issues.is_empty(),
                    "valid traveler with issues at {t}"
                );
                continue;
            }
            assert!(
                !g.secret.issues.is_empty(),
                "flawed traveler without issues at {t}"
            );
            for issue in &g.secret.issues {
                for pair in &issue.pairs {
                    for field in pair {
                        assert!(
                            super::super::model::is_known_field(field),
                            "unknown field {field}"
                        );
                    }
                }
                if issue.kind == "tell" {
                    assert!(g.secret.tell.is_some());
                }
            }
        }
    }

    #[test]
    fn bulletins_and_wanted_schedule() {
        let first = (0..60).find(|t| bulletin_at(&SEED, *t).is_some()).unwrap();
        assert!((10..15).contains(&first), "first bulletin at {first}");
        let b = bulletin_at(&SEED, first).unwrap();
        assert_eq!(b.remaining_at(first), 5);
        assert!(
            bulletin_at(&SEED, first + 5).is_none(),
            "window lasts 5 travelers"
        );
        // 突发规则期间：违反者判为有破绽，并可以用 bul.规则 指认
        let mut violators = 0;
        for t in 0..400 {
            let g = traveler(&SEED, t, "e");
            if g.secret.bulletin {
                violators += 1;
                assert!(
                    bulletin_at(&SEED, t).is_some(),
                    "bulletin violation outside window"
                );
                assert!(!g.secret.ok.contains(&Decision::Approve));
                assert!(g
                    .secret
                    .issues
                    .iter()
                    .any(|i| i.kind == "bulletin" && i.pairs[0].contains(&"bul.规则".to_string())));
            }
        }
        assert!(violators > 0);

        for block in 0..5 {
            let wanted = wanted_for(&SEED, block);
            assert!((block * 40 + 10..block * 40 + 31).contains(&wanted.appear_at));
            assert_ne!(
                (wanted.surname.as_str(), wanted.given.as_str()),
                (wanted.alias_surname.as_str(), wanted.alias_given.as_str())
            );
            let g = traveler(&SEED, wanted.appear_at, "e");
            assert!(g.secret.wanted);
            assert_eq!(g.public.person, wanted.person);
            for t in block * 40..block * 40 + 40 {
                if t != wanted.appear_at {
                    let other = traveler(&SEED, t, "e");
                    assert_ne!(other.public.person, wanted.person, "look-alike at {t}");
                }
            }
        }
    }

    #[test]
    fn rush_and_clones_shapes() {
        for w in (0..20).step_by(2) {
            let WaveSpec::Rush { faces } = wave(&SEED, w) else {
                panic!()
            };
            assert_eq!(faces.len(), RUSH_FACES);
            let approves = faces.iter().filter(|f| f.ok == Decision::Approve).count();
            assert!((2..=4).contains(&approves));
        }
        let WaveSpec::Clones { runners } = wave(&SEED, 1) else {
            panic!()
        };
        assert_eq!(runners.len(), CLONES);
        assert!(runners.iter().all(|c| c.travel_ms() > 1000));
    }

    /// 生成结果的指纹：生成逻辑一旦改变这里就会失败，提醒提升 GENERATOR_VERSION。
    #[test]
    fn golden_hash_for_generator_version() {
        let mut hasher = Sha256::new();
        for t in 0..60 {
            let g = traveler(&[9u8; 32], t, "ent_golden");
            hasher.update(serde_json::to_vec(&g.public).unwrap());
            hasher.update(serde_json::to_vec(&g.secret).unwrap());
        }
        for w in 0..6 {
            hasher.update(serde_json::to_vec(&wave(&[9u8; 32], w)).unwrap());
        }
        let digest = hex::encode(hasher.finalize());
        assert_eq!(GENERATOR_VERSION, 1);
        assert_eq!(
            digest, GOLDEN_V1,
            "generator output changed: bump GENERATOR_VERSION and update GOLDEN"
        );
    }

    const GOLDEN_V1: &str = "b87a0b4cfd4bae0107a2227a0f266c243c8852e5c2146b9d08fc16266ba1cc98";
}
