//! 无尽模式的数据结构：下发给前端的公开部分 / 只留在服务器的答案。
//!
//! 公开部分只有「证件上写了什么」：没有 ok、破绽、理由、反应台词、马脚位置、是否说谎。
//! 答案（`Secret`）只序列化进 `state_json`，永远不进响应。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Approve,
    Deny,
    Detain,
}

impl Decision {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "approve" => Some(Decision::Approve),
            "deny" => Some(Decision::Deny),
            "detain" => Some(Decision::Detain),
            _ => None,
        }
    }
}

/// 一句台词：`[说话人, 原文, 可选的演出参数]`（与前端 `runSteps` 的格式一致）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Line(
    pub String,
    pub String,
    #[serde(default)] pub Option<serde_json::Value>,
);

impl Line {
    pub fn entrant(text: &str) -> Self {
        Line("E".into(), text.into(), None)
    }

    pub fn with(who: &str, text: &str, opts: serde_json::Value) -> Self {
        Line(who.into(), text.into(), Some(opts))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pay {
    pub brand: String,
    pub last4: String,
    #[serde(rename = "virtual")]
    pub virtual_card: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Doc {
    Passport {
        key: String,
        cc: String,
        photo: String,
        surname: String,
        given: String,
        dob: String,
        sex: String,
        iss: String,
        exp: String,
    },
    Device {
        key: String,
        ip: String,
        loc: String,
        tz: String,
        lang: String,
        device: String,
        net: String,
    },
    Account {
        key: String,
        pay: Pay,
        bill: String,
        phone: String,
    },
    ModelPermit {
        key: String,
        claim: String,
        model_id: String,
        org: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Login {
    pub ago_days: u8,
    pub time: String,
    pub loc: String,
}

/// 下发给前端的旅客（证件内容）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PublicEntrant {
    pub entrant_id: String,
    pub seq: u32,
    pub person: String,
    pub voice: i64,
    pub intro: Vec<Line>,
    pub primary: String,
    pub docs: Vec<Doc>,
    pub logins: Vec<Login>,
    pub xray: Vec<String>,
}

/// 一处破绽：`kind` + 显示参数 + 能指认它的字段组合（顺序无关）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Issue {
    pub kind: String,
    pub args: BTreeMap<String, String>,
    pub pairs: Vec<Vec<String>>,
}

/// 告诉前端的破绽（指认成功或判定后揭晓）：前端按 `kind` 取文案。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssueView {
    pub kind: String,
    pub args: BTreeMap<String, String>,
    pub fields: Vec<String>,
}

impl Issue {
    pub fn view(&self, fields: Option<&[String]>) -> IssueView {
        IssueView {
            kind: self.kind.clone(),
            args: self.args.clone(),
            fields: fields
                .map(<[String]>::to_vec)
                .unwrap_or_else(|| self.pairs.first().cloned().unwrap_or_default()),
        }
    }

    /// 指认的字段组合是否命中（两项时顺序无关）。
    pub fn matches(&self, fields: &[String]) -> bool {
        self.pairs.iter().any(|pair| {
            pair.len() == fields.len()
                && match fields {
                    [a] => pair[0] == *a,
                    [a, b] => (pair[0] == *a && pair[1] == *b) || (pair[0] == *b && pair[1] == *a),
                    _ => false,
                }
        })
    }
}

/// 只留在服务器的答案。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Secret {
    pub ok: Vec<Decision>,
    pub flaws: Vec<String>,
    pub issues: Vec<Issue>,
    /// 露出马脚的那句开场白（`intro` 的下标）
    pub tell: Option<usize>,
    /// 测谎会露馅（会接中文梗）
    pub liar: bool,
    pub fish: Option<String>,
    pub wanted: bool,
    pub bulletin: bool,
}

/// 检查模式可以点选的字段（输入白名单）。
pub fn is_known_field(key: &str) -> bool {
    const FIELDS: [&str; 40] = [
        "pp.header",
        "pp.name",
        "pp.photo",
        "pp.DOB",
        "pp.SEX",
        "pp.ISS",
        "pp.EXP",
        "dv.IP",
        "dv.归属",
        "dv.时区",
        "dv.语言",
        "dv.设备",
        "dv.网络",
        "ac.付款",
        "ac.账单",
        "ac.手机",
        "md.申报",
        "md.模型ID",
        "md.发行",
        "md.申请地区",
        "log.body",
        "log.last",
        "xr.cat",
        "xr.keys",
        "xr.rice",
        "xr.lunch",
        "rule.region",
        "rule.tz",
        "rule.quiz",
        "rule.pay",
        "rule.xray",
        "rule.corp",
        "rule.model",
        "rule.net",
        "bul.规则",
        "bul.剩余",
        "wt.photo",
        "wt.name",
        "face",
        "say",
    ];
    FIELDS.contains(&key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_matching_is_order_free() {
        let issue = Issue {
            kind: "tz".into(),
            args: BTreeMap::new(),
            pairs: vec![
                vec!["pp.header".into(), "dv.时区".into()],
                vec!["xr.cat".into()],
            ],
        };
        assert!(issue.matches(&["dv.时区".into(), "pp.header".into()]));
        assert!(issue.matches(&["pp.header".into(), "dv.时区".into()]));
        assert!(issue.matches(&["xr.cat".into()]));
        assert!(!issue.matches(&["pp.header".into()]));
        assert!(!issue.matches(&["dv.时区".into(), "rule.tz".into()]));
    }

    #[test]
    fn decisions_parse() {
        assert_eq!(Decision::parse("detain"), Some(Decision::Detain));
        assert_eq!(Decision::parse("Approve"), None);
        assert_eq!(serde_json::to_string(&Decision::Deny).unwrap(), "\"deny\"");
    }
}
