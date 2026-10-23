//! 无尽模式的生成用表（从前端 `data.js` 移植）。
//!
//! 会显示给玩家的字符串必须与前端 JS 里的原文一字不差：翻译以中文原句为键，
//! 像素字库也只收录前端 JS 里出现过的字。`tests::strings_exist_in_client` 会逐条核对。

pub struct City {
    pub name: &'static str,
    pub tz: &'static str,
    pub st: &'static str,
    pub code: &'static str,
    pub en: &'static str,
}

pub struct Country {
    pub cc: &'static str,
    pub name: &'static str,
    pub lang: &'static str,
    pub cities: &'static [City],
    pub first: &'static [&'static str],
    pub last: &'static [&'static str],
    pub hello: &'static [&'static str],
}

const fn city(
    name: &'static str,
    tz: &'static str,
    st: &'static str,
    code: &'static str,
    en: &'static str,
) -> City {
    City {
        name,
        tz,
        st,
        code,
        en,
    }
}

pub const COUNTRIES: [Country; 5] = [
    Country {
        cc: "US",
        name: "美国",
        lang: "en-US",
        cities: &[
            city("纽约", "America/New_York", "NY", "212", "NEW YORK"),
            city("洛杉矶", "America/Los_Angeles", "CA", "213", "LOS ANGELES"),
            city("芝加哥", "America/Chicago", "IL", "312", "CHICAGO"),
            city("西雅图", "America/Los_Angeles", "WA", "206", "SEATTLE"),
            city("休斯敦", "America/Chicago", "TX", "713", "HOUSTON"),
            city("丹佛", "America/Denver", "CO", "720", "DENVER"),
            city("波士顿", "America/New_York", "MA", "617", "BOSTON"),
        ],
        first: &[
            "JAMES", "MARY", "ROBERT", "LINDA", "DAVID", "SARAH", "KEVIN", "ASHLEY", "BRIAN",
            "MEGAN", "JASON", "NANCY",
        ],
        last: &[
            "MILLER", "DAVIS", "GARCIA", "WILSON", "MOORE", "CLARK", "LEWIS", "HALL", "YOUNG",
            "KING", "LOPEZ", "NGUYEN",
        ],
        hello: &["Hi.", "Morning.", "How's it going?", "Hey there.", "Hello!"],
    },
    Country {
        cc: "UK",
        name: "英国",
        lang: "en-GB",
        cities: &[
            city("伦敦", "Europe/London", "LDN", "+44 20", "LONDON"),
            city("曼彻斯特", "Europe/London", "MAN", "+44 161", "MANCHESTER"),
        ],
        first: &["OLIVER", "HARRY", "AMELIA", "GEORGE", "EMMA", "JACK"],
        last: &["SMITH", "JONES", "TAYLOR", "EVANS", "HUGHES", "WRIGHT"],
        hello: &["Cheers, mate.", "Lovely weather.", "Good morning."],
    },
    Country {
        cc: "JP",
        name: "日本",
        lang: "ja-JP",
        cities: &[
            city("东京", "Asia/Tokyo", "TKY", "+81 3", "TOKYO"),
            city("大阪", "Asia/Tokyo", "OSK", "+81 6", "OSAKA"),
        ],
        first: &["HIROSHI", "YUKI", "KENJI", "AIKO", "TAKESHI", "HANA"],
        last: &["TANAKA", "SATO", "SUZUKI", "ITO", "WATANABE", "KATO"],
        hello: &["Konnichiwa!", "Ohayou.", "Hello desu."],
    },
    Country {
        cc: "DE",
        name: "德国",
        lang: "de-DE",
        cities: &[
            city("柏林", "Europe/Berlin", "BER", "+49 30", "BERLIN"),
            city("慕尼黑", "Europe/Berlin", "MUC", "+49 89", "MUNICH"),
        ],
        first: &["LUKAS", "ANNA", "FELIX", "LENA", "JONAS", "MIA"],
        last: &["MULLER", "SCHMIDT", "WEBER", "BECKER", "WAGNER", "KOCH"],
        hello: &["Guten Tag.", "Hallo.", "Moin."],
    },
    Country {
        cc: "SG",
        name: "新加坡",
        lang: "en-SG",
        cities: &[city("新加坡", "Asia/Singapore", "SG", "+65", "SINGAPORE")],
        first: &["WEI MING", "MEI LING", "JUN JIE", "HUI MIN", "RAJ", "SITI"],
        last: &["TAN", "LIM", "LEE", "NG", "KUMAR", "WONG"],
        hello: &["Hello lah.", "Morning!", "Can or not?"],
    },
];

pub fn country(cc: &str) -> &'static Country {
    COUNTRIES
        .iter()
        .find(|country| country.cc == cc)
        .unwrap_or(&COUNTRIES[0])
}

/// 合规旅客的国籍权重（与 `randomEntrant` 相同）。
pub const VALID_CC: [&str; 8] = ["US", "US", "US", "US", "UK", "JP", "DE", "SG"];

pub const CN_LOCS: [&str; 9] = [
    "中国 · 北京 · 联通",
    "中国 · 上海 · 电信",
    "中国 · 广东 · 移动",
    "中国 · 四川 · 电信",
    "中国 · 江苏 · 移动",
    "中国 · 湖北 · 电信",
    "中国 · 浙江 · 联通",
    "中国 · 澳门",
    "中国 · 香港",
];

pub const DEVICES: [&str; 6] = [
    "Windows 11",
    "MacBook",
    "iPhone",
    "Android",
    "iPad",
    "Linux",
];

pub const STREETS: [&str; 8] = [
    "12 Oak St",
    "480 Pine Ave",
    "77 Maple Dr",
    "1500 Elm St",
    "23 Cedar Ln",
    "9 Lake Rd",
    "310 Hill St",
    "6 Birch Ct",
];

/// 非剧情立绘池（`ASSETS.people` 里 scripted=false 的 24 位）与性别。
pub const PORTRAITS: [(&str, &str); 24] = [
    ("P00", "M"),
    ("P01", "M"),
    ("P02", "M"),
    ("P03", "M"),
    ("P04", "M"),
    ("P05", "M"),
    ("P06", "M"),
    ("P07", "M"),
    ("P08", "M"),
    ("P09", "M"),
    ("P10", "F"),
    ("P11", "M"),
    ("P12", "M"),
    ("P13", "F"),
    ("P14", "M"),
    ("P15", "M"),
    ("P16", "F"),
    ("P17", "M"),
    ("P18", "M"),
    ("P19", "M"),
    ("P20", "M"),
    ("P21", "M"),
    ("P22", "M"),
    ("P23", "M"),
];

pub fn portrait_sex(person: &str) -> &'static str {
    PORTRAITS
        .iter()
        .find(|(id, _)| *id == person)
        .map(|(_, sex)| *sex)
        .unwrap_or("M")
}

pub const IP_FIRST_OCTET: [u8; 10] = [23, 34, 45, 64, 72, 98, 104, 142, 172, 203];
pub const IP_FIRST_OCTET_CN: [u8; 8] = [36, 58, 106, 111, 115, 120, 183, 223];
pub const PAY_BRANDS: [&str; 4] = ["VISA", "VISA", "MASTERCARD", "AMEX"];
pub const SMS_AREAS: [&str; 4] = ["209", "310", "415", "646"];

/// 伪装者开口露出的马脚（`RANDOM_TELLS[i][0]`），破绽说明与追问台词在前端按序号取。
pub const TELL_SAYS: [&str; 4] = [
    "嗯嗯，yes.",
    "OK 的。",
    "You can you up.",
    "Good good study.",
];
pub const CNIP_HELLO: [&str; 2] = ["I'm American!", "Hi, I work in China."];

pub const FISH_PERSON: &str = "FISH";
pub const FISH_VOICE: i64 = 165;
pub const FISH_NAMES: [&str; 3] = ["BLUB", "FISHY", "BUBBLE"];
pub const FISH_HELLO: [&str; 4] = [
    "我在 GitHub 上可是有很多 Star 的！",
    "我又来了！这次绝对没问题！",
    "（深深地看了你一眼）",
    "你慢慢查，我去吃饭了。",
];
pub const FISH_CAD_LOC: &str = "加拿大 · 多伦多";

/// 黑话快剪：说中文黑话的（拒绝）配专属立绘，说人话的（准予）从立绘池里抽。
pub const RUSH_DENY: [(&str, &str); 4] = [
    ("SLANG0", "家人们谁懂啊"),
    ("SLANG1", "yyds"),
    ("SLANG2", "绝绝子"),
    ("SLANG3", "老板说今晚必须上线"),
];
pub const RUSH_APPROVE: [&str; 6] = [
    "Have a nice day!",
    "Thanks, man.",
    "Morning.",
    "Cheers, mate.",
    "Good morning.",
    "Hey there.",
];

/// 通缉令罪名（前端 `ENDLESS_TEXT.crimes` 按序号显示文字）。
pub const WANTED_CRIMES: usize = 4;

#[cfg(test)]
mod tests {
    use super::*;

    const DATA_JS: &str = include_str!("../../../data.js");
    const ENDLESS_JS: &str = include_str!("../../../endless.js");

    fn quoted(s: &str) -> Vec<String> {
        vec![format!("'{s}'"), format!("\"{s}\"")]
    }

    fn in_client(s: &str) -> bool {
        quoted(s)
            .iter()
            .any(|q| DATA_JS.contains(q.as_str()) || ENDLESS_JS.contains(q.as_str()))
    }

    #[test]
    fn strings_exist_in_client() {
        let mut missing = Vec::new();
        let mut check = |s: &str| {
            if !in_client(s) {
                missing.push(s.to_string());
            }
        };
        for country in &COUNTRIES {
            check(country.name);
            for hello in country.hello {
                check(hello);
            }
            for city in country.cities {
                check(city.name);
            }
        }
        for s in CN_LOCS.iter().chain(DEVICES.iter()).chain(STREETS.iter()) {
            check(s);
        }
        for s in TELL_SAYS
            .iter()
            .chain(CNIP_HELLO.iter())
            .chain(FISH_HELLO.iter())
            .chain(FISH_NAMES.iter())
            .chain(RUSH_APPROVE.iter())
        {
            check(s);
        }
        for (_, line) in RUSH_DENY {
            check(line);
        }
        check(FISH_CAD_LOC);
        assert!(
            missing.is_empty(),
            "strings not found in client JS: {missing:?}"
        );
    }

    #[test]
    fn portraits_match_client_assets() {
        let assets = include_str!("../../../assets.js");
        for (id, sex) in PORTRAITS {
            let needle = format!("\"{id}\":{{\"expr\"");
            let at = assets
                .find(&needle)
                .unwrap_or_else(|| panic!("{id} missing in assets.js"));
            let tail = &assets[at..at + 200];
            assert!(
                tail.contains("\"scripted\":false"),
                "{id} must be a pool portrait"
            );
            assert!(
                tail.contains(&format!("\"sex\":\"{sex}\"")),
                "{id} sex mismatch"
            );
        }
    }
}
