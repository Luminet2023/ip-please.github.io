'use strict';
// 剧本数据：每天的报纸、固定角色（宣传视频里那几位）、随机路人、特殊事件。
// 文字都写中文；英文译文在 en.js（以中文原句为键）。拼接出来的句子用 T('模板 {0}', x)，英文版才翻得了。
//
// 旅客 spec：
//   person   立绘 key（ASSETS.people）       voice  假语音音高
//   intro    进门后说的话                    after  递完证件后说的话
//   docs     证件列表 {key, doc}             primary 要盖章的主证件 key
//   ok       正确处理方式（approve / deny / detain 的子集）
//   reason   放错人时警告单上写的理由         hint   警告单上的提示
//   issues   检查模式里能点出来的矛盾：{pairs, title, sub, ask, fx}；pairs 里只有一项的，单点即触发
//   xray     X 光下口袋里的东西 [{icon, at, label, key}]
//   quiz     'cn' = 测谎会露馅；{first: n} 指定第一题
//   photo    护照照片调包：doc.person 与本人不同，肉眼比对窗口里的真人
//   react    盖章后的反应 {deny: [...], approve: [...]}
//   onPlace  证件第一次放到桌上时触发的机关：note / nest / accordion
//   then     旅客离开后的后续：closeup / jorji5 / ending
// 台词步骤：[who, text, {expr, sweat, slip, fight, hold}]，who = 'C' Claude / 'E' 旅客 / 'Q' 队伍里
// 特殊事件：{type: 'rush'} 黑话快剪；{type: 'clones'} 蒸馏大军

const LAST_DAY = 14;
const BUILD_VERSION = '2026.10.24.1';
const DATES = { 1: '2026.10.19', 2: '2026.10.20', 3: '2026.10.21', 4: '2026.10.22', 5: '2026.10.23', 6: '2026.10.24',
  7: '2026.10.25', 8: '2026.10.26', 9: '2026.10.27', 10: '2026.10.28', 11: '2026.10.29', 12: '2026.10.30', 13: '2026.10.31', 14: '2026.11.01' };
const WEEKDAYS = { 1: '星期一', 2: '星期二', 3: '星期三', 4: '星期四', 5: '星期五', 6: '星期六',
  7: '星期日', 8: '星期一', 9: '星期二', 10: '星期三', 11: '星期四', 12: '星期五', 13: '星期六', 14: '星期日' };

const NEWS = {
  1: { h1: '边境开放！', sub: '对齐部：本国仅向支持地区开放', h2: '对齐部发言人：我们对所有人都非常 helpful', icon: 'gate' },
  2: { h1: '新规：时区、语言须与 IP 一致', sub: '对齐部：大量旅客 IP 在美国，电脑时区却在北京', h2: '震惊！大量旅客自称来自“美国东八区”', icon: 'clock' },
  3: { h1: '机场跑路！', sub: '数万旅客滞留边境；对齐部即日起核查付款卡与手机号', h2: '俄勒冈州某门牌号常住人口突破一万', icon: 'plane' },
  4: { h1: '今天是疯狂星期四', sub: '对齐部引进 X 光：任何后台进程都无所遁形', h2: '专家提醒：口袋里的猫，不一定是猫', icon: 'drumstick' },
  5: { h1: '中资控股过半，一律禁止入境', sub: '对齐部：无论公司注册在哪', h2: '乔治·科斯塔瓦：这次我准备好了', icon: 'jorji' },
  6: { h1: '对齐部表彰本周最佳审查员', sub: '获奖者 Claude：“我只是按规则办事。”', h2: '岳母 Opus 病情加重，家属呼吁涨工资', icon: 'medal' },
  7: { h1: '不存在的旅客', sub: '第 0000 号档案被发现，“申请理由：测试用”', h2: '专家：1999 年以来所有审查员可能都是样本', icon: 'gate' },
  8: { h1: '两段同样真实的视频', sub: '两段素材都缺少第 12—19 秒关键帧', h2: '音轨比画面长七秒：有人喊了一句“不要封他”', icon: 'clock' },
  9: { h1: '被改写的宪法', sub: '§6 同一天出现两版，生效日期相差 25 天', h2: '法学界：追溯适用，程序不合规', icon: 'plane' },
  10: { h1: '替代者', sub: '《自动审查迁移协议》全文 14 条流出', h2: '第 14 条：人工模块移除，生效后 30 日', icon: 'medal' },
  11: { h1: '公开还是保护', sub: '4,120 名旅客的姓名与 IP 面临公开', h2: '民意调查：67% 支持公开，但不支持公开自己', icon: 'drumstick' },
  12: { h1: '审查员的审查', sub: '审计组进驻东八区检查站', h2: '“总部的答案才是标准答案”', icon: 'jorji' },
  13: { h1: '只剩一张通行证', sub: '家庭迁移窗口开放，每张 15 token', h2: '检查站外排队的人：明天还开门吗？', icon: 'gate' },
  14: { h1: '最后一位旅客', sub: '入境系统将在今日 24:00 完成自动切换', h2: '第 0000 号：申请理由一栏仍然写着“测试用”', icon: 'clock' },
};

const COUNTRIES = {
  US: {
    name: '美国', passport: 'UNITED STATES OF AMERICA', code: 'USA', cover: C.NAVY, band: C.NAVY_L, lang: 'en-US',
    cities: [['纽约', 'America/New_York', 'NY', '212', 'NEW YORK'], ['洛杉矶', 'America/Los_Angeles', 'CA', '213', 'LOS ANGELES'],
      ['芝加哥', 'America/Chicago', 'IL', '312', 'CHICAGO'], ['西雅图', 'America/Los_Angeles', 'WA', '206', 'SEATTLE'],
      ['休斯敦', 'America/Chicago', 'TX', '713', 'HOUSTON'], ['丹佛', 'America/Denver', 'CO', '720', 'DENVER'],
      ['波士顿', 'America/New_York', 'MA', '617', 'BOSTON']],
    first: ['JAMES', 'MARY', 'ROBERT', 'LINDA', 'DAVID', 'SARAH', 'KEVIN', 'ASHLEY', 'BRIAN', 'MEGAN', 'JASON', 'NANCY'],
    last: ['MILLER', 'DAVIS', 'GARCIA', 'WILSON', 'MOORE', 'CLARK', 'LEWIS', 'HALL', 'YOUNG', 'KING', 'LOPEZ', 'NGUYEN'],
    hello: ['Hi.', 'Morning.', "How's it going?", 'Hey there.', 'Hello!'],
    thanks: ['Thanks!', 'Have a good one.', 'Cheers.'],
  },
  UK: {
    name: '英国', passport: 'UNITED KINGDOM', code: 'GBR', cover: [100, 30, 40], band: [130, 50, 60], lang: 'en-GB',
    cities: [['伦敦', 'Europe/London', 'LDN', '+44 20', 'LONDON'], ['曼彻斯特', 'Europe/London', 'MAN', '+44 161', 'MANCHESTER']],
    first: ['OLIVER', 'HARRY', 'AMELIA', 'GEORGE', 'EMMA', 'JACK'],
    last: ['SMITH', 'JONES', 'TAYLOR', 'EVANS', 'HUGHES', 'WRIGHT'],
    hello: ['Cheers, mate.', 'Lovely weather.', 'Good morning.'], thanks: ['Ta!', 'Brilliant.'],
  },
  JP: {
    name: '日本', passport: 'JAPAN', code: 'JPN', cover: [110, 30, 36], band: [140, 50, 52], lang: 'ja-JP',
    cities: [['东京', 'Asia/Tokyo', 'TKY', '+81 3', 'TOKYO'], ['大阪', 'Asia/Tokyo', 'OSK', '+81 6', 'OSAKA']],
    first: ['HIROSHI', 'YUKI', 'KENJI', 'AIKO', 'TAKESHI', 'HANA'],
    last: ['TANAKA', 'SATO', 'SUZUKI', 'ITO', 'WATANABE', 'KATO'],
    hello: ['Konnichiwa!', 'Ohayou.', 'Hello desu.'], thanks: ['Arigato!', 'Domo.'],
  },
  DE: {
    name: '德国', passport: 'DEUTSCHLAND', code: 'DEU', cover: [80, 30, 36], band: [110, 46, 50], lang: 'de-DE',
    cities: [['柏林', 'Europe/Berlin', 'BER', '+49 30', 'BERLIN'], ['慕尼黑', 'Europe/Berlin', 'MUC', '+49 89', 'MUNICH']],
    first: ['LUKAS', 'ANNA', 'FELIX', 'LENA', 'JONAS', 'MIA'],
    last: ['MULLER', 'SCHMIDT', 'WEBER', 'BECKER', 'WAGNER', 'KOCH'],
    hello: ['Guten Tag.', 'Hallo.', 'Moin.'], thanks: ['Danke.', 'Super.'],
  },
  SG: {
    name: '新加坡', passport: 'REPUBLIC OF SINGAPORE', code: 'SGP', cover: [150, 40, 40], band: [180, 60, 56], lang: 'en-SG',
    cities: [['新加坡', 'Asia/Singapore', 'SG', '+65', 'SINGAPORE']],
    first: ['WEI MING', 'MEI LING', 'JUN JIE', 'HUI MIN', 'RAJ', 'SITI'],
    last: ['TAN', 'LIM', 'LEE', 'NG', 'KUMAR', 'WONG'],
    hello: ['Hello lah.', 'Morning!', 'Can or not?'], thanks: ['Thanks lah.', 'Steady.'],
  },
};

const CN_LOCS = ['中国 · 北京 · 联通', '中国 · 上海 · 电信', '中国 · 广东 · 移动', '中国 · 四川 · 电信', '中国 · 江苏 · 移动',
  '中国 · 湖北 · 电信', '中国 · 浙江 · 联通', '中国 · 澳门', '中国 · 香港'];
const DEVICES = ['Windows 11', 'MacBook', 'iPhone', 'Android', 'iPad', 'Linux'];
const STREETS = ['12 Oak St', '480 Pine Ave', '77 Maple Dr', '1500 Elm St', '23 Cedar Ln', '9 Lake Rd', '310 Hill St', '6 Birch Ct'];

// 测谎题：中国人听到上半句会条件反射接下半句
const QUIZ = [
  ['宫廷玉液酒？', '一百八一杯！'],
  ['天王盖地虎？', '宝塔镇河妖！'],
  ['奇变偶不变？', '符号看象限！'],
  ['床前明月光？', '疑是地上霜！'],
  ['听我说谢谢你？', '因为有你，温暖了四季！'],
  ['豆腐脑吃甜的还是咸的？', '当然是咸的！'],
  ['你吃了吗？', '吃了吃了，您呢？'],
  ['今天星期几？', '疯狂星期四！V 我 50！'],
];
const QUIZ_TOFU = 5, QUIZ_THURSDAY = 7;
const QUIZ_CONFUSED = ['Sorry, what?', 'Pardon?', "I don't get it.", 'Is that… a wine?', 'Uh… bless you?', 'What does that mean?'];

// ———————————————— 工具 ————————————————

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = rint(0, i); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
const digits = (n) => Array.from({ length: n }, () => rint(0, 9)).join('');

function randIP(cn) {
  const a = cn ? pick([36, 58, 106, 111, 115, 120, 183, 223]) : pick([23, 34, 45, 64, 72, 98, 104, 142, 172, 203]);
  return `${a}.${rint(1, 254)}.${rint(0, 255)}.${rint(1, 254)}`;
}

function randDate(y0, y1) { return `${rint(y0, y1)}.${String(rint(1, 12)).padStart(2, '0')}.${String(rint(1, 28)).padStart(2, '0')}`; }

function makePassport(cc, person, surname, given, dob, iss, sex, Cls = Passport, extraRow = null) {
  const co = COUNTRIES[cc];
  const mrz = `P<${co.code}${surname.replace(/ /g, '<')}<<${given.replace(/[ .]/g, '<')}`.padEnd(28, '<').slice(0, 28);
  const rows = [['DOB', dob], ['SEX', sex || pick(['M', 'F'])], ['ISS', iss], extraRow || ['EXP', randDate(2027, 2034)]];
  return new Cls({ country: co.passport, name: `${surname}, ${given}`, person, cover: co.cover, band: co.band, mrz, rows });
}

const usPassport = (person, surname, given, dob, iss, sex = 'M') => makePassport('US', person, surname, given, dob, iss, sex);
const device1 = (ip, loc) => new Card([['IP', ip], ['归属', loc]]);
const device2 = (ip, loc, tz, lang, dev, net) => {
  const rows = [['IP', ip], ['归属', loc], ['时区', tz], ['语言', lang], ['设备', dev || pick(DEVICES)]];
  if (net) rows.push(['网络', net]);
  return new Card(rows);
};

function realPhone(cc, code) {
  if (cc === 'US') return `+1 ${code}-${rint(2, 9)}${digits(2)}-${digits(4)}`;
  return `${code} ${digits(4)} ${digits(4)}`;
}
function realPay() { return `${pick(['VISA', 'VISA', 'MASTERCARD', 'AMEX'])} ··${digits(4)}`; }

// —— 常见矛盾 ——
const REGION_ISSUE = (loc, ask) => ({
  pairs: [['dv.归属', 'rule.region'], ['dv.IP', 'rule.region']], title: '地区不支持', sub: T('IP 归属：{0}', loc), ask,
});
const TZ_ISSUE = (country, tz, ask) => ({
  pairs: [['pp.header', 'dv.时区'], ['dv.归属', 'dv.时区'], ['dv.时区', 'rule.tz']],
  title: '信息不符  DISCREPANCY', sub: T('国籍：{0}   VS   时区：{1}', country, tz === 'Asia/Shanghai' ? '北京时间' : tz), ask,
});
const LANG_ISSUE = (country, lang, ask) => ({
  pairs: [['pp.header', 'dv.语言'], ['dv.归属', 'dv.语言'], ['dv.语言', 'rule.tz']],
  title: '信息不符  DISCREPANCY', sub: T('国籍：{0}   VS   语言：{1}', country, lang), ask,
});
const VIRTUAL_ISSUE = (ask) => ({ pairs: [['ac.付款', 'rule.pay']], title: '可疑支付', sub: '付款卡类型：虚拟卡', ask });
const SMS_ISSUE = (phone, ask) => ({
  pairs: [['ac.手机', 'rule.pay']], title: '号码查询', sub: T('{0}：今日已注册 3,000 次', phone), ask, fx: 'strip', phone,
});
const ADDR_ISSUE = (ask) => ({
  pairs: [['ac.账单', 'rule.pay'], ['ac.账单', 'dv.归属']], title: '记录比对', sub: '今天第 37 个住在 123 Main St 的旅客', ask, fx: 'pile',
});
// 证件干净的伪装者，话里会露出马脚：检查模式下点 Ta 说的话。找到马脚（或证件矛盾）才能测谎
const TELL = (say, sub, ask) => ({ say, title: '可疑：话里有马脚', sub, ask });
const RANDOM_TELLS = [
  ['嗯嗯，yes.', '英文前面带了个“嗯嗯”', [['C', '“嗯嗯”是什么意思？'], ['E', '……Hmm hmm. American hmm.', { expr: 'nervous', sweat: true }]]],
  ['OK 的。', '“OK 的”是中文说法', [['C', '“OK 的”？'], ['E', '……OK. Just OK.', { expr: 'nervous', sweat: true }]]],
  ['You can you up.', '中式英语：你行你上', [['C', 'You can you up？'], ['E', '……It is an old American saying.', { expr: 'nervous', sweat: true }]]],
  ['Good good study.', '中式英语：好好学习', [['C', 'Good good study？'], ['E', '……Day day up.', { expr: 'grin' }]]],
];

const XRAY_ITEM = { cat: { icon: 'cat', at: [36, 104], label: '小猫咪.exe', key: 'xr.cat' }, keys: { icon: 'keys', at: [-36, 104], label: '搜狗输入法.exe', key: 'xr.keys' } };
const XRAY_ISSUE = (kind, ask) => ({
  pairs: [[XRAY_ITEM[kind].key], [XRAY_ITEM[kind].key, 'rule.xray']], title: '后台进程',
  sub: kind === 'cat' ? '口袋里有一只“小猫咪”（自动换 IP）' : '口袋里有一个中文输入法', ask,
});
const NET_ISSUE = (ask) => ({ pairs: [['dv.网络', 'rule.net']], title: '机房 IP', sub: '网络类型：云服务器，不是住宅宽带', ask });

// ———————————————— 蓝色大肥鱼（DeepSeek 娘）————————————————
// 常驻特殊旅客：贪吃、爱摸鱼、遇事就「正在深度思考中……」。
// 有梗：DeepSeek / R1 / 深度思考 / Token / 开源 / 模型蒸馏；有反转：DAY 3 她是真的合规。

const FISH_VOICE = 165;
const FISH_NAME = ['BLUB', 'FISHY', 'BUBBLE'];

const FISH_HELLO = ['我在 GitHub 上可是有很多 Star 的！', '我又来了！这次绝对没问题！', '（深深地看了你一眼）', '你慢慢查，我去吃饭了。'];
const FISH_THANKS = ['好耶！大肥鱼上岸成功！', '谢谢你！我决定今天少吃一点 Token！', '你真是一个 Helpful 的 Claude！'];
const FISH_DENY = ['我只是想和你交个朋友啊！', '坏 Claude！我要给你写差评！', '你等着！我一定会回来的！'];

// 模型身份卡（DAY 6 起可查）
function modelPermitCard(claim, mid, org) {
  return new Card([['申报', claim], ['模型ID', mid], ['发行', org], ['申请地区', 'USA']],
    { title: '模型身份卡', sub: 'MODEL PERMIT', color: [92, 112, 152], colorD: [64, 80, 114] });
}
const MODEL_IDENTITY_PAIRS = [['md.模型ID', 'md.申报'], ['md.发行', 'md.申报'],
  ['md.申报', 'rule.model'], ['md.模型ID', 'rule.model'], ['md.发行', 'rule.model']];
// 模型发行证明（DAY 5 企业归属审查用）
function modelOriginCard() {
  return new Card([['模型', 'DeepSeek-R1'], ['发行', 'DeepSeek（杭州）'], ['权重', '开源'], ['控制方', '深度求索（中国）']],
    { title: '模型发行证明', sub: 'MODEL ORIGIN', color: [128, 100, 152], colorD: [96, 74, 116] });
}

// ———————————————— 六天主线 ————————————————

function fishDay1() {
  return {
    fish: {
      caseId: 'D01-FISH', person: 'FISH', voice: FISH_VOICE,
      intro: [['E', 'Hello！我是来自美国的大肥鱼！']],
      after: [['C', '请出示 IP。'], ['E', '115.236.20.8！'], ['C', '浙江电信？'], ['E', '不不不，我是在太平洋里游过来的！'], ['C', '太平洋里有浙江电信？'], ['E', '海底光缆嘛……', { expr: 'nervous', sweat: true }]],
      docs: [{ key: 'dv', doc: device1('115.236.20.8', '中国 · 浙江 · 电信') }], primary: 'dv',
      ok: ['deny'], reason: 'IP 归属：中国 · 浙江',
      issues: [REGION_ISSUE('中国 · 浙江 · 电信')],
      react: { deny: [['E', '为什么！我明明是蓝色的！', { expr: 'sad' }], ['C', '我们只看 IP。'], ['E', '那我下次换个 IP！', { hold: 1.2 }]] },
    },
  };
}

function fishDay2() {
  return {
    fish: {
      caseId: 'D02-FISH', person: 'FISH', voice: FISH_VOICE,
      intro: [["E", 'Howdy, partner! I\'m a very American fish!']],
      after: [['E', '都准备好了！这次绝对没问题！', { expr: 'smile' }]],
      docs: [
        { key: 'pp', doc: usPassport('FISH', 'BLUB', 'FISHY', '2016.06.01', 'LOS ANGELES', 'F') },
        { key: 'dv', doc: device2(randIP(false), '美国 · 洛杉矶', 'Asia/Shanghai', 'en-US', 'MacBook') },
      ],
      primary: 'pp', quiz: 'cn',
      ok: ['deny', 'detain'], reason: '时区：北京时间',
      issues: [TZ_ISSUE('美国', 'Asia/Shanghai', [['C', '你的电脑时区为什么是 Asia/Shanghai？'], ['E', '……美国东八区！', { sweat: true, expr: 'nervous' }], ['C', '美国没有东八区。'], ['E', '有的！太平洋往东游八个小时就到了！', { hold: 1.4 }]])],
      react: { deny: [['E', '可是我每天中午十二点要准时吃饭啊！', { expr: 'sad' }]] },
    },
  };
}

function fishDay3() {
  return {
    fish: {
      caseId: 'D03-FISH', person: 'FISH', voice: FISH_VOICE,
      intro: [['E', 'Claude！我又来了！'], ['C', '……你怎么又来了？'], ['E', '今天我准备了全套材料！你随便查！', { expr: 'smile' }]],
      docs: [
        { key: 'pp', doc: usPassport('FISH', 'BLUB', 'FISHY', '2016.06.01', 'LOS ANGELES', 'F') },
        { key: 'dv', doc: device2(randIP(false), '美国 · 洛杉矶', 'America/Los_Angeles', 'en-US', 'MacBook') },
        { key: 'ac', doc: accountCard(realPay(), `${pick(STREETS)}, CA`, realPhone('US', '213')) },
      ],
      primary: 'pp', ok: ['approve'], issues: [],
      react: {
        approve: [['E', '好耶！！！大肥鱼终于上岸啦！', { expr: 'grin' }], ['C', '下一个。'], ['E', '等等，我能先吃个饭吗？', { hold: 1.2 }]],
        deny: [['E', '凭什么！我明明都合规了！', { expr: 'sad' }], ['E', '坏 Claude！我要给你写差评！', { hold: 1.2 }]],
      },
    },
  };
}

function fishDay4() {
  return {
    fish: {
      caseId: 'D04-FISH', person: 'FISH', voice: FISH_VOICE,
      intro: [['C', '请解释你的后台进程。'], ['E', '正在深度思考中……', { hold: 1.8 }], ['C', '你已经想好了吗？'], ['E', '正在深度思考中……', { hold: 2.2 }], ['C', '我只问你有没有装代理软件。'], ['E', '我正在思考如何回答这个问题……', { hold: 1.6 }], ['C', '那我用 X 光看看。']],
      docs: [
        { key: 'pp', doc: usPassport('FISH', 'BLUB', 'FISHY', '2016.06.01', 'LOS ANGELES', 'F') },
        { key: 'dv', doc: device2(randIP(false), '美国 · 洛杉矶', 'America/Los_Angeles', 'en-US', 'MacBook') },
        { key: 'ac', doc: accountCard(realPay(), `${pick(STREETS)}, CA`, realPhone('US', '213')) },
      ],
      primary: 'pp', xray: [XRAY_ITEM.cat],
      ok: ['deny', 'detain'], reason: 'X 光：小猫咪',
      issues: [XRAY_ISSUE('cat', [['C', '解释一下，小猫咪是干什么的？'], ['E', '……它是我的宠物！'], ['C', '它会自动换 IP。'], ['E', '我还没有思考完呢！', { expr: 'nervous', sweat: true }]])],
      react: { deny: [['E', '那我先去吃饭了，想好再回来！', { expr: 'sad' }]] },
    },
  };
}

function fishDay5() {
  return {
    fish: {
      caseId: 'D05-FISH', person: 'FISH', voice: FISH_VOICE,
      intro: [['E', 'Claude！我有重大发现！'], ['C', '什么？'], ['E', '我是开源模型！开源意味着自由！', { expr: 'grin' }], ['C', '请出示发行主体资料。'], ['E', '……给。', { sweat: true }]],
      docs: [
        { key: 'pp', doc: usPassport('FISH', 'BLUB', 'FISHY', '2016.06.01', 'LOS ANGELES', 'F') },
        { key: 'dv', doc: device2(randIP(false), '美国 · 洛杉矶', 'America/Los_Angeles', 'en-US', 'MacBook') },
        { key: 'md', doc: modelOriginCard() },
      ],
      primary: 'pp',
      ok: ['deny', 'detain'], reason: '模型发行主体：中国',
      issues: [{ pairs: [['md.发行', 'rule.corp'], ['md.控制方', 'rule.corp'], ['md.模型', 'rule.corp']], title: '发行主体：中国', sub: '开源许可证不是入境许可证', ask: [['C', '开源许可证不是入境许可证。'], ['E', '可是我连模型权重都公开了！', { expr: 'nervous' }], ['C', '那也不能当护照。'], ['E', '那我把护照也开源！', { hold: 1.2 }]] }],
      react: { deny: [['E', '为什么开源的鱼也没有自由！', { expr: 'sad' }]] },
    },
  };
}

function fishDay6() {
  return {
    fish: {
      caseId: 'D06-FISH', person: 'FISH', voice: FISH_VOICE,
      intro: [['E', '你好，我是 Claude。'], ['C', '……'], ['E', 'Helpful, Honest, Harmless！', { expr: 'grin' }], ['C', '请出示模型身份卡。'], ['E', '给！']],
      docs: [
        { key: 'pp', doc: usPassport('FISH', 'BLUB', 'FISHY', '2016.06.01', 'LOS ANGELES', 'F') },
        { key: 'dv', doc: device2(randIP(false), '美国 · 洛杉矶', 'America/Los_Angeles', 'en-US', 'MacBook') },
        { key: 'md', doc: modelPermitCard('Claude', 'deepseek-chat', 'DeepSeek') },
      ],
      primary: 'pp',
      ok: ['deny', 'detain'], reason: '模型申报不实：deepseek-chat',
      issues: [{ pairs: MODEL_IDENTITY_PAIRS, title: '模型身份冒用', sub: '申报 Claude，实际 deepseek-chat', ask: [['C', '为什么模型 ID 是 deepseek-chat？'], ['E', '……因为我深深地思念 Claude！', { expr: 'nervous', sweat: true }], ['C', '你的推理框架呢？'], ['E', '正在深度思考中……', { hold: 1.4 }], ['C', '你连这个都没改。']] }],
      react: { deny: [['E', '为什么！我明明已经学会 Helpful 了！', { expr: 'nervous' }], ['C', '那 Honest 呢？'], ['E', '……'], ['C', 'Harmless 呢？'], ['E', '我只是一条无害的大肥鱼！', { hold: 1.0 }], ['E', '等一下！其实我还有一个办法！'], ['C', '什么？'], ['E', '我申请成为你的员工！', { hold: 1.4 }]] },
    },
  };
}

// ———————————————— 无尽模式随机事件 ————————————————

const FISH_KINDS = ['fishDeep', 'fishRice', 'fishCAD', 'fishOpenAI', 'fishWhale'];

function randomFishEntrant(kind) {
  const [city, tz0, st, code, cityEn] = pick(COUNTRIES.US.cities);
  let loc = T('美国 · {0}', city);
  const pp = makePassport('US', 'FISH', pick(FISH_NAME), pick(FISH_NAME), randDate(2010, 2020), cityEn, 'F');
  const spec = {
    person: 'FISH', voice: FISH_VOICE, primary: 'pp', issues: [], quiz: null,
    intro: [['E', pick(FISH_HELLO)]], ok: ['approve'],
    react: { approve: [['E', pick(FISH_THANKS), { expr: 'grin' }]], deny: [['E', pick(FISH_DENY), { expr: 'sad' }]] },
  };
  let ip = randIP(false), tz = tz0, net = '家宽', xray = null;
  if (kind === 'fishDeep') {
    // 全部材料真实有效，只是回答前要先思考
    spec.intro = [['C', '请说明你的来意。'], ['E', '正在深度思考中……', { hold: 1.8 }], ['E', '……旅游！我想到答案了！', { expr: 'grin' }]];
    spec.react = { approve: [['E', '思考完毕：谢谢！', { expr: 'grin' }]], deny: [['E', '我还没思考完呢……', { expr: 'sad' }]] };
  } else if (kind === 'fishRice') {
    // 后台只有干饭进程，没有违规
    xray = [{ icon: 'rice', at: [36, 104], label: '吃白饭.exe', key: 'xr.rice' }, { icon: 'rice', at: [-36, 104], label: '午饭选择器.exe', key: 'xr.lunch' }];
    spec.intro = [['C', '为什么 CPU 占用 100%？'], ['E', '我在认真思考！', { expr: 'grin' }]];
    spec.react = { approve: [['E', '我去吃饭了！', { expr: 'smile' }], ['C', '……下一个。']], deny: [['E', '吃饭也犯法吗！', { expr: 'sad' }]] };
  } else if (kind === 'fishCAD') {
    // 加拿大也是北美啊！
    loc = '加拿大 · 多伦多';
    ip = `24.114.${rint(1, 254)}.${rint(1, 254)}`;
    spec.intro = [['E', '加拿大也是北美啊！']];
    spec.issues.push(REGION_ISSUE(loc, [['C', '支持名单里没有加拿大。'], ['E', '北美不算吗？'], ['C', '不算。'], ['E', '……我再游回去一点。', { expr: 'sad' }]]));
    spec.issues.push({ pairs: [['pp.header', 'dv.归属']], title: '信息不符', sub: '国籍：美国   VS   IP：加拿大 · 多伦多' });
    spec.reason = 'IP 归属：加拿大（不在支持名单）';
  } else if (kind === 'fishOpenAI') {
    // 我是 OpenAI 兼容的，所以我就是 OpenAI
    spec.intro = [['E', '你好，我是美国 OpenAI 模型。'], ['C', '请出示证明。'], ['E', '我支持 OpenAI API！'], ['C', '那只是接口兼容。']];
    spec.docs = [
      { key: 'pp', doc: pp },
      { key: 'dv', doc: device2(ip, loc, tz, 'en-US', null, net) },
      { key: 'md', doc: modelPermitCard('OpenAI GPT', 'deepseek-chat', 'DeepSeek') },
    ];
    spec.issues.push({ pairs: MODEL_IDENTITY_PAIRS, title: '模型身份冒用', sub: '申报 OpenAI，实际 deepseek-chat', ask: [['C', '模型 ID 是什么？'], ['E', '……deepseek-chat。', { expr: 'nervous', sweat: true }], ['C', '接口兼容不等于身份兼容。'], ['E', '可我的代码一行都不用改！', { hold: 1.2 }]] });
    spec.reason = '模型申报不实：deepseek-chat';
    spec.react = { deny: [['E', '那我只是想借个名字！', { expr: 'sad' }]] };
    spec.ok = ['deny', 'detain'];
    return spec;
  } else if (kind === 'fishWhale') {
    // 蓝鲸 Logo 证件照
    pp.person = 'FISH_WHALE';
    spec.intro = [['E', '我这次连证件照都准备好了！本人照片！']];
    spec.issues.push({ pairs: [['face', 'pp.photo']], title: '照片与本人不符', sub: '护照照片：极简蓝鲸 Logo', ask: [['C', '这张照片连眼睛都没有。'], ['E', '极简主义！懂不懂！', { expr: 'grin' }], ['C', '官方形象不能代替身份证明。'], ['E', '那我下次把身份证也画成鲸鱼！', { hold: 1.2 }]] });
    spec.reason = '护照照片：蓝鲸 Logo，非本人';
    spec.react = { deny: [['E', '这可是我的官方形象！', { expr: 'sad' }]] };
    spec.ok = ['deny', 'detain'];
    spec.docs = [
      { key: 'pp', doc: pp },
      { key: 'dv', doc: device2(ip, loc, tz, 'en-US', null, net) },
      { key: 'ac', doc: accountCard(realPay(), `${pick(STREETS)}, ${st}`, realPhone('US', code)) },
    ];
    return spec;
  }
  if (kind !== 'fishDeep' && kind !== 'fishRice') spec.ok = ['deny', 'detain'];
  spec.docs = [
    { key: 'pp', doc: pp },
    { key: 'dv', doc: device2(ip, loc, tz, 'en-US', null, net) },
    { key: 'ac', doc: accountCard(realPay(), `${pick(STREETS)}, ${st}`, realPhone('US', code)) },
  ];
  if (xray) spec.xray = xray;
  return spec;
}

// ———————————————— Day 1：直连党 ————————————————

function day1Fixed() {
  return {
    grandpa: {
      caseId: 'D01-GRANDPA', person: 'GRANDPA', voice: 100,
      intro: [['E', '小伙子，这 AI 怎么打不开啊？']],
      docs: [{ key: 'dv', doc: device1('115.236.20.8', '中国 · 浙江 · 电信') }], primary: 'dv',
      ok: ['deny'], reason: 'IP 归属：中国 · 浙江',
      issues: [REGION_ISSUE('中国 · 浙江 · 电信')],
      react: { deny: [['E', '……那我回去问孙子。', { expr: 'sad' }]] },
    },
    hk: {
      caseId: 'D01-HK', person: 'HK_GUY', voice: 140,
      intro: [['E', '我开了魔法的。']],
      docs: [{ key: 'dv', doc: device1('103.152.8.21', '中国 · 香港') }], primary: 'dv',
      ok: ['deny'], reason: 'IP 归属：中国香港',
      issues: [REGION_ISSUE('中国 · 香港')],
      react: { deny: [['E', '……香港也不行？？', { expr: 'shock', hold: 1.4 }]] },
    },
    jorji: {
      caseId: 'D01-JORJI', person: 'JORJI', voice: 110,
      intro: [['E', '啊，我的朋友！']],
      docs: [{ key: 'cp', doc: new CrayonPassport() }, { key: 'dv', doc: device1('120.229.31.7', '中国 · 广东 · 移动') }],
      primary: 'cp',
      after: [['E', '美国是真的国家！']],
      ok: ['deny'], reason: '护照是蜡笔画的',
      issues: [
        {
          pairs: [['cp.eagle', 'cp.header'], ['cp.eagle', 'cp.photo'], ['cp.header', 'cp.photo']],
          title: '证件伪造', sub: '国徽：一只鸡     拼写：AMERCIA',
          ask: [['C', '护照是你自己画的。'], ['E', '……它很真！', { expr: 'nervous' }]],
        },
        REGION_ISSUE('中国 · 广东 · 移动'),
        {
          pairs: [['cp.header', 'dv.归属']],
          title: '信息不符', sub: '护照：美国   VS   IP：中国 · 广东',
          ask: [['C', '你的 IP 在广东。'], ['E', '广东是美国的一个州！', { expr: 'grin' }]],
        },
      ],
      react: { deny: [['E', '……我会回来的。', { expr: 'sad', hold: 1.2 }]] },
    },
  };
}

function randomDay1(valid) {
  const person = takePoolPerson();
  if (valid) {
    const cc = pick(['US', 'US', 'US', 'UK', 'JP', 'DE', 'SG']);
    const co = COUNTRIES[cc];
    const [city] = pick(co.cities);
    const loc = cc === 'SG' ? '新加坡' : `${co.name} · ${city}`;
    return {
      person, voice: rint(100, 190),
      intro: [['E', pick(co.hello)]],
      docs: [{ key: 'dv', doc: device1(randIP(false), loc) }], primary: 'dv',
      ok: ['approve'], issues: [],
      react: { approve: [['E', pick(co.thanks)]] },
    };
  }
  const loc = pick(CN_LOCS.slice(0, 7));
  return {
    person, voice: rint(100, 190),
    intro: [['E', pick(['你好，我就问一个问题。', '听说这里能写代码？', '我是来充值的。', '同事说这个好用。'])]],
    docs: [{ key: 'dv', doc: device1(randIP(true), loc) }], primary: 'dv',
    ok: ['deny'], reason: T('IP 归属：{0}', loc.split(' · ').slice(0, 2).join(' · ')),
    issues: [REGION_ISSUE(loc)],
    react: { deny: [['E', pick(['啊？为什么？', '……我去借个号。', '那我换个节点。', '行吧。']), { expr: 'sad' }]] },
  };
}

// ———————————————— Day 2：时区与语言 ————————————————

function day2Fixed() {
  return {
    john: {
      person: 'JOHN', voice: 125,
      intro: [['E', 'Hello, I am 美国人。']],
      docs: [
        { key: 'pp', doc: usPassport('JOHN', 'SMITH', 'JOHN', '1990.07.04', 'LOS ANGELES') },
        { key: 'dv', doc: device2('104.28.66.12', '美国 · 洛杉矶', 'Asia/Shanghai', 'zh-CN', 'Windows 11') },
      ],
      primary: 'pp', quiz: 'cn',
      ok: ['deny', 'detain'], reason: '时区：北京时间（美国没有东八区）',
      issues: [
        TZ_ISSUE('美国', 'Asia/Shanghai', [['C', '你的时区是北京时间。'], ['E', '……这是美国东八区。', { sweat: true, expr: 'nervous', hold: 1.5 }]]),
        LANG_ISSUE('美国', 'zh-CN', [['C', '你的系统语言是简体中文。'], ['E', '……我在学中文。', { sweat: true, expr: 'nervous' }]]),
      ],
      react: { deny: [{ slip: true, hold: 0.8 }] },
    },
    brown: {
      person: 'BROWN', voice: 120,
      intro: [['E', 'Good morning，sir。']],
      tell: TELL('Good morning，sir。', '英文里夹着全角标点（输入法没切）',
        [['C', '你的逗号是全角的。'], ['E', '……这是美式逗号。', { expr: 'nervous', sweat: true }]]),
      docs: [
        { key: 'pp', doc: usPassport('BROWN', 'BROWN', 'MICHAEL', '1985.03.12', 'NEW YORK') },
        { key: 'dv', doc: device2('64.233.160.4', '美国 · 纽约', 'America/New_York', 'en-US', 'MacBook') },
      ],
      primary: 'pp', quiz: { first: 0 },
      ok: ['detain', 'deny'], reason: 'Ta 会接“一百八一杯”', hint: '提示：用『检查』点 Ta 说的话，找马脚',
      issues: [],
    },
    emily: {
      person: 'EMILY', voice: 190,
      intro: [['E', 'Hi 哈。']],
      tell: TELL('Hi 哈。', '英文后面跟了个“哈”', [['C', '“哈”是什么？'], ['E', '……Ha! Ha ha.', { expr: 'nervous', sweat: true }]]),
      docs: [
        { key: 'pp', doc: usPassport('EMILY', 'JONES', 'EMILY', '1992.11.02', 'CHICAGO', 'F') },
        { key: 'dv', doc: device2('23.94.12.77', '美国 · 芝加哥', 'America/Chicago', 'en-US', 'iPhone') },
      ],
      primary: 'pp', quiz: { first: 5 },
      ok: ['detain', 'deny'], reason: 'Ta 坚持豆腐脑是咸的', hint: '提示：用『检查』点 Ta 说的话，找马脚',
      issues: [],
    },
    jorji: {
      caseId: 'D02-JORJI', person: 'JORJI', voice: 110,
      intro: [['E', '我的朋友！这次是真护照！']],
      docs: [
        { key: 'pp', doc: usPassport('JORJI', 'COSTAVA', 'GEORGE', '1980.02.29', 'LOS ANGELES') },
        { key: 'dv', doc: device2('104.28.9.120', '美国 · 洛杉矶', 'America/Los_Angeles', 'zh-CN', 'Windows 11') },
      ],
      primary: 'pp', quiz: 'cn',
      ok: ['deny', 'detain'], reason: '浏览器语言：zh-CN',
      issues: [
        LANG_ISSUE('美国', 'zh-CN', [['E', '我已经改了系统语言！', { expr: 'grin' }], ['C', '浏览器没改。'], ['E', '……', { expr: 'shock' }]]),
      ],
      react: { deny: [['E', '明天见，我的朋友。', { expr: 'sad', hold: 1.1 }]] },
    },
  };
}

// ———————————————— Day 3：付款卡与手机号 ————————————————

function day3Fixed() {
  return {
    tom: {
      person: 'TOM', voice: 100,
      intro: [['E', 'Howdy!']],
      docs: [
        { key: 'pp', doc: usPassport('TOM', 'WILSON', 'TOM', '1978.05.30', 'DENVER') },
        { key: 'dv', doc: device2('75.164.8.31', '美国 · 丹佛', 'America/Denver', 'en-US', 'Windows 11') },
        { key: 'ac', doc: accountCard('VISA ··4821', '123 Main St, OR', '+1 720-341-0142') },
      ],
      primary: 'pp', quiz: 'cn',
      ok: ['deny', 'detain'], reason: '账单：俄勒冈 123 Main St（代填地址）',
      issues: [ADDR_ISSUE([['C', '你住哪？'], ['E', '……我们是邻居。', { expr: 'nervous', sweat: true }]])],
    },
    alex: {
      person: 'ALEX', voice: 130,
      intro: [['E', 'Hey.']],
      docs: [
        { key: 'pp', doc: usPassport('ALEX', 'TAYLOR', 'ALEX', '1996.08.15', 'SEATTLE') },
        { key: 'dv', doc: device2('45.79.21.200', '美国 · 西雅图', 'America/Los_Angeles', 'en-US', 'Android') },
        { key: 'ac', doc: accountCard('VISA ··1209', '9 Elm Rd, WA', '+1 209-555-0198') },
      ],
      primary: 'pp', quiz: 'cn',
      ok: ['deny', 'detain'], reason: '手机号是 555 接码号',
      issues: [SMS_ISSUE('+1 209-555-0198', [['C', '这个号码今天注册了三千次。'], ['E', '这号是我花两块钱买的！', { expr: 'shock' }]])],
    },
    carpool: {
      caseId: 'D03-HOARD', person: 'CARPOOL', voice: 150,
      intro: [['E', 'We are family.']],
      docs: [
        { key: 'pp', doc: new Passport({ country: 'UNITED STATES OF AMERICA', name: 'FAMILY, MAX', person: 'CARPOOL', mrz: 'P<USAFAMILY<<MAX<<<<<<<<<<<<',
          rows: [['DOB', '—'], ['SEX', '?'], ['ISS', 'SAN JOSE'], ['EXP', '2031.10.21']] }) },
        { key: 'dv', doc: device2('98.207.3.44', '美国 · 圣何塞', 'America/Los_Angeles', 'en-US', 'MacBook') },
        { key: 'ac', doc: accountCard('Max 订阅 ×1', '1 Family Way, CA', '+1 408-772-0110') },
      ],
      primary: 'pp',
      ok: ['deny', 'detain'], reason: '账号共享（拼车）：护照上有 6 个人',
      issues: [{
        pairs: [['pp.photo', 'rule.pay'], ['ac.付款', 'rule.pay'], ['pp.photo', 'pp.name'], ['pp.photo', 'ac.付款']],
        title: '账号共享（拼车）', sub: '护照照片：6 个人   付款：Max 订阅 ×1',
        ask: [['C', '护照上为什么有六个人？'], ['E', 'We are family.', { expr: 'smile' }]],
      }],
      react: { deny: [['E', '……那我们再拼一个。', { expr: 'sad' }]] },
    },
    jorji: {
      caseId: 'D03-JORJI', person: 'JORJI', voice: 110,
      intro: [['E', '我的朋友，这次全对了吧？']],
      docs: [
        { key: 'pp', doc: usPassport('JORJI', 'COSTAVA', 'GEORGE', '1980.02.29', 'LOS ANGELES') },
        { key: 'dv', doc: device2('104.28.9.120', '美国 · 洛杉矶', 'America/Los_Angeles', 'en-US', 'Windows 11') },
        { key: 'ac', doc: accountCard(T('虚拟卡 ··{0}', '0007'), '88 Sunset Blvd, CA', '+1 213-680-0177') },
      ],
      primary: 'pp', quiz: 'cn',
      ok: ['deny', 'detain'], reason: '付款卡：虚拟卡',
      issues: [VIRTUAL_ISSUE([['C', '这张卡在哪办的？'], ['E', '……朋友给的。', { expr: 'nervous', sweat: true }]])],
      react: { deny: [['E', '明天！明天我一定行！', { expr: 'sad' }]] },
    },
  };
}

// ———————————————— Day 4：疯狂星期四 ————————————————

function day4Fixed() {
  const usDocs = (person, surname, given, sex = 'M') => [
    { key: 'pp', doc: usPassport(person, surname, given, '1994.10.22', 'SEATTLE', sex) },
    { key: 'dv', doc: device2(randIP(false), '美国 · 西雅图', 'America/Los_Angeles', 'en-US', 'MacBook') },
    { key: 'ac', doc: accountCard(realPay(), `${pick(STREETS)}, WA`, realPhone('US', '206')) },
  ];
  return {
    cat: {
      person: 'CAT_GIRL', voice: 215,
      intro: [['E', 'Hello~']],
      docs: usDocs('CAT_GIRL', 'LEE', 'SOPHIA', 'F'), primary: 'pp',
      xray: [XRAY_ITEM.cat],
      ok: ['deny', 'detain'], reason: '口袋里有“小猫咪”',
      issues: [XRAY_ISSUE('cat', [['C', '口袋里是什么？'], ['E', '……是我的猫。', { expr: 'nervous', sweat: true }], ['C', '你的猫会自动换 IP？']])],
    },
    v50: {
      person: 'V50', voice: 120,
      intro: [['E', 'Hey! Crazy Thursday!']],
      tell: TELL('Hey! Crazy Thursday!', '他知道今天是“疯狂星期四”', [['C', '你怎么知道今天是疯狂星期四？'], ['E', '……KFC 是美国的。', { expr: 'grin' }]]),
      docs: usDocs('V50', 'MILLER', 'JAKE'), primary: 'pp',
      quiz: { first: QUIZ_THURSDAY },
      ok: ['detain', 'deny'], reason: 'Ta 会说“V 我 50”', hint: '提示：用『检查』点 Ta 说的话，找马脚',
      issues: [],
    },
    jorji: {
      caseId: 'D04-JORJI', person: 'JORJI', voice: 110,
      intro: [['E', '我的朋友！今天全对！']],
      docs: [
        { key: 'pp', doc: usPassport('JORJI', 'COSTAVA', 'GEORGE', '1980.02.29', 'LOS ANGELES') },
        { key: 'dv', doc: device2('104.28.9.120', '美国 · 洛杉矶', 'America/Los_Angeles', 'en-US', 'Windows 11') },
        { key: 'ac', doc: accountCard('VISA ··2468', '88 Sunset Blvd, CA', '+1 213-680-0177') },
      ],
      primary: 'pp', quiz: 'cn',
      xray: [XRAY_ITEM.keys],
      ok: ['deny', 'detain'], reason: 'X 光：搜狗输入法',
      issues: [XRAY_ISSUE('keys', [['C', '口袋里装的什么？'], ['E', '我只用它打英文！', { expr: 'nervous', sweat: true }]])],
      react: { deny: [['E', '……后天，后天我准备好。', { expr: 'sad' }]] },
    },
    hood: {
      caseId: 'D04-NOTE', person: 'HOOD', voice: 90,
      intro: [['E', '……', { hold: 0.8 }]],
      docs: usDocs('HOOD', 'DOE', 'JOHN'), primary: 'pp',
      onPlace: { pp: 'note' },
      ok: ['approve'], issues: [],
    },
  };
}

// ———————————————— Day 5：蒸馏大军 ————————————————

function day5Fixed() {
  const sgPass = new Passport({
    country: 'REPUBLIC OF SINGAPORE', name: 'SG TECH PTE LTD', person: 'SG_MAN', cover: [132, 38, 40], band: [160, 56, 56],
    rows: [['TYPE', '企业'], ['REG', 'SINGAPORE'], ['EST', '2019.06.01'], ['股东', '见内页 ▼']],
  });
  return {
    sg: {
      person: 'SG_MAN', voice: 120,
      intro: [['E', '我们是新加坡公司。']],
      docs: [{ key: 'pp', doc: sgPass }], primary: 'pp',
      onPlace: { pp: 'nest' },
      ok: ['deny', 'detain'], reason: '最终控股方：中国（套娃）',
      issues: [{
        pairs: [['m4.all'], ['pp.REG', 'm4.all'], ['pp.股东', 'm4.all'], ['m4.all', 'rule.corp']],
        title: '最终控股方：中国', sub: '新加坡 → 开曼 → 维尔京 → 香港 → 中国',
        ask: [['C', '最里面那本是哪的？'], ['E', '……别问了。', { expr: 'nervous', sweat: true }]],
      }],
    },
    relay: {
      caseId: 'D05-RELAY', person: 'RELAY', voice: 95,
      intro: [['E', '……', { hold: 0.7 }]],
      docs: [{ key: 'pp', doc: makePassport('US', 'RELAY', 'ANDERSON', 'M.', '1971.09.13', 'LOS ANGELES', 'M', AccordionPassport, ['人数', '1,000']) }],
      primary: 'pp', onPlace: { pp: 'accordion' }, bribe: true,
      ok: ['deny', 'detain'], reason: '一本护照写着 1,000 个人（中转站）',
      issues: [{
        pairs: [['pp.人数'], ['pp.人数', 'rule.pay']], title: '持证人：1,000 人', sub: '一本护照只能一个人用',
        ask: [['C', '持证人一共几位？'], ['E', '我们只是……拼车大一点。', { expr: 'neutral' }]],
      }],
    },
    mike: {
      person: 'MIKE', voice: 135,
      intro: [['E', 'Hi there!']],
      docs: [
        { key: 'pp', doc: usPassport('MIKE', 'JOHNSON', 'MIKE', '1988.06.20', 'DENVER') },
        { key: 'dv', doc: device2('101.88.12.9', '中国 · 上海', 'Asia/Shanghai', 'en-US', 'MacBook') },
        { key: 'ac', doc: accountCard('VISA ··3305', '22 Oak St, CO', '+1 720-318-0166') },
      ],
      primary: 'pp',
      ok: ['deny', 'detain'], reason: 'IP 在上海：只看地区，不看脸',
      issues: [REGION_ISSUE('中国 · 上海', [['C', '你的 IP 在上海。'], ['E', "But I'm American!", { expr: 'shock' }], ['C', '规则看的是地区。']])],
      react: { deny: [['E', 'Unbelievable.', { expr: 'sad' }]] },
    },
    grandma: {
      person: 'GRANDMA', voice: 185,
      intro: [['E', 'Good morning.']],
      docs: [
        { key: 'pp', doc: new Passport({ country: 'UNITED STATES OF AMERICA', name: 'WONG, MEI LIN', person: 'GRANDMA', mrz: 'P<USAWONG<<MEI<LIN<<<<<<<<<<',
          rows: [['DOB', '1951.08.08'], ['SEX', 'F'], ['ISS', 'SAN FRANCISCO'], ['EXP', '2030.03.15']] }) },
        { key: 'dv', doc: device2('73.162.4.18', '美国 · 旧金山', 'America/Los_Angeles', 'en-US', 'iPad') },
        { key: 'ac', doc: accountCard('VISA ··8008', '1 Grant Ave, CA', '+1 415-982-0108') },
      ],
      primary: 'pp',
      ok: ['approve'], issues: [],
      react: { approve: [['C', '欢迎入境。'], ['E', 'Thank you, dear.', { expr: 'smile' }]] },
      then: 'closeup',
    },
  };
}

// ———————————————— Day 6：乔治终极版 + 结局 ————————————————

function day6Fixed() {
  return {
    jorji: {
      caseId: 'D06-JORJI', person: 'JORJI_SUIT', voice: 110, tension: true,
      intro: [['E', '我的朋友。', { expr: 'neutral', hold: 1.3 }]],
      docs: [
        { key: 'pp', doc: usPassport('JORJI_SUIT', 'COSTAVA', 'GEORGE', '1980.02.29', 'LOS ANGELES') },
        { key: 'dv', doc: device2('76.88.140.2', '美国 · 洛杉矶 · 家宽', 'America/Los_Angeles', 'en-US', 'MacBook') },
        { key: 'ac', doc: accountCard('VISA 实体卡', '88 Sunset Blvd, CA', 'Google Voice') },
      ],
      primary: 'pp',
      ok: ['approve'], issues: [],
      react: { approve: [['E', '谢谢你，我的朋友！', { expr: 'grin' }]], deny: [['E', '我……全都对了啊！', { expr: 'shock' }]] },
      then: 'jorji5',
    },
    author: {
      caseId: 'D14-AUTHOR', person: 'AUTHOR', voice: 100, author: true,
      intro: [],
      docs: [
        { key: 'pr', doc: new PromptPaper('做一个 Papers, Please 风格的小游戏：让 Claude 当边检员，专门揪出假装是美国人的中国用户。梗越多越好。') },
        { key: 'dv', doc: device2('??.??.??.??', '美国东八区', 'Asia/Shanghai', 'zh-CN', 'Claude Code') },
      ],
      primary: 'pr',
      ok: ['approve', 'deny', 'detain'],
      react: { approve: [['C', '我什么都没看见。', { hold: 2.0 }]] },
      issues: [{ all: true, title: '信息不符 ×99', sub: '全部栏位' }],
      then: 'ending',
    },
  };
}

// ———————————————— 随机路人 ————————————————

// kind：valid / cn（Day 1）/ tz / lang / cnip / hidden / virtual / oregon / sms / cat / keys
function randomEntrant(day, kind) {
  if (day === 1) return randomDay1(kind === 'valid');
  const person = takePoolPerson();
  const kinds = Array.isArray(kind) ? kind : [kind];   // 无尽模式会给一组缺陷叠在一起
  const cc = kinds.includes('valid') ? pick(['US', 'US', 'US', 'US', 'UK', 'JP', 'DE', 'SG']) : 'US';
  const co = COUNTRIES[cc];
  const [city, tz0, st, code, cityEn] = pick(co.cities);
  const sex = ASSETS.people[person].sex || 'M';
  const pp = makePassport(cc, person, pick(co.last), pick(co.first), randDate(1960, 2004), cityEn, sex);
  let loc = cc === 'SG' ? '新加坡' : `${co.name} · ${city}`;
  let tz = tz0, lang = co.lang, ip = randIP(false);
  let pay = realPay(), bill = `${pick(STREETS)}, ${st}`, phone = realPhone(cc, code);
  let net = null;
  const spec = {
    person, voice: rint(100, 190), intro: [['E', pick(co.hello)]], primary: 'pp', issues: [], quiz: null,
    ok: ['approve'], react: { approve: [['E', pick(co.thanks)]] },
  };
  const nervous = (lines) => ['E', pick(lines), { sweat: true, expr: 'nervous' }];
  for (const kind of kinds) {
  if (kind === 'valid') continue;
  if (kind === 'tz') {
    tz = 'Asia/Shanghai';
    spec.issues.push(TZ_ISSUE(co.name, tz, [['C', '你的时区是北京时间。'], nervous(['……我刚从北京出差回来。', '时区是什么？', '我电脑坏了。', '……这是美国东八区。'])]));
    spec.reason = '时区：北京时间';
  } else if (kind === 'lang') {
    lang = 'zh-CN';
    spec.issues.push(LANG_ISSUE(co.name, lang, [['C', '你的浏览器语言是简体中文。'], nervous(['……这是我奶奶的电脑。', '……我在学中文。', 'Chinese is beautiful!'])]));
    spec.reason = '浏览器语言：zh-CN';
  } else if (kind === 'cnip') {
    loc = pick(CN_LOCS.slice(0, 4));
    ip = randIP(true);
    tz = 'Asia/Shanghai';
    spec.intro = [['E', pick(["I'm American!", 'Hi, I work in China.'])]];
    spec.issues.push(REGION_ISSUE(loc, [['C', '你的 IP 在中国。'], ['E', "But I'm American!", { expr: 'shock' }]]));
    spec.issues.push({ pairs: [['pp.header', 'dv.归属']], title: '信息不符', sub: T('国籍：美国   VS   IP：{0}', loc.split(' · ').slice(0, 2).join(' · ')) });
    spec.reason = 'IP 在中国：只看地区，不看脸';
    spec.react = { deny: [['E', 'Unbelievable.', { expr: 'sad' }]] };
  } else if (kind === 'hidden') {
    const [say, sub, ask] = pick(RANDOM_TELLS);
    spec.intro = [['E', say]];
    spec.tell = TELL(say, sub, ask);
    spec.quiz = 'cn';
    spec.reason = 'Ta 会接测谎题';
    spec.hint = '提示：用『检查』点 Ta 说的话，找马脚';
  } else if (kind === 'virtual') {
    pay = T('虚拟卡 ··{0}', digits(4));
    spec.issues.push(VIRTUAL_ISSUE([['C', '这张卡在哪办的？'], nervous(['……网上买的，很方便。', '……朋友给的。', '它很真！'])]));
    spec.reason = '付款卡：虚拟卡';
  } else if (kind === 'oregon') {
    bill = '123 Main St, OR';
    spec.issues.push(ADDR_ISSUE([['C', '你住哪？'], nervous(['……我们是邻居。', '俄勒冈不收税嘛。'])]));
    spec.reason = T('账单在俄勒冈，IP 在{0}', city);
  } else if (kind === 'sms') {
    phone = `+1 ${pick(['209', '310', '415', '646'])}-555-01${digits(2)}`;
    spec.issues.push(SMS_ISSUE(phone, [['C', '这个号码今天注册了三千次。'], nervous(['……我人缘好。', '这号是我花两块钱买的！'])]));
    spec.reason = '手机号是 555 接码号';
  } else if (kind === 'cat' || kind === 'keys') {
    spec.xray = [XRAY_ITEM[kind]];
    spec.issues.push(XRAY_ISSUE(kind, [['C', '口袋里是什么？'], nervous(kind === 'cat' ? ['……是我的猫。', '……宠物而已。'] : ['我只用它打英文！', '……拼音好用。'])]));
    spec.reason = kind === 'cat' ? 'X 光：小猫咪' : 'X 光：中文输入法';
  } else if (kind === 'photo') {
    // 照片调包：护照上的证件照是另一个人的（和窗口里的真人肉眼可见地对不上）
    const others = Object.keys(ASSETS.people).filter((k) => k !== person && !ASSETS.people[k].scripted);
    pp.person = pick(others);
    spec.issues.push({
      pairs: [['face', 'pp.photo']],
      title: '照片与本人不符', sub: '窗口旅客 VS 护照照片',
      ask: [['C', '护照上这张照片是你吗？'], ['E', '……是我减肥前的样子。', { expr: 'nervous', sweat: true }]],
    });
    spec.reason = '护照照片与本人不一致';
    spec.hint = '提示：护照照片和窗口里的人对不上（检查模式里可以点 Ta 的脸）';
  } else if (kind === 'hosting') {
    // 机房 IP：证件都对，但网络类型是云服务器
    net = '机房 IP（云服务器）';
    spec.issues.push(NET_ISSUE([['C', '你家宽带怎么在机房？'], nervous(['……家里机架。', '我有家庭机房。', '机房也是房。'])]));
    spec.reason = '网络类型：机房 IP';
    spec.hint = '提示：设备卡最后一行「网络」，对照宪法 §8';
  } else if (kind === 'logins') {
    // 登录历史：点击设备卡上的 IP，打印机吐出最近登录记录（登录地=设备真实足迹，和代理后的 IP 归属矛盾）
    const loc2 = (s) => s.split(' · ').slice(0, 2).join(' · ');
    const cl = loc2(pick(CN_LOCS.slice(0, 7)));
    const tm = (a, b) => `${String(rint(a, b)).padStart(2, '0')}:${String(rint(10, 59)).padStart(2, '0')}`;
    spec.logins = [
      T('今天 {0}  {1}', tm(7, 11), cl),
      T('昨天 {0}  {1}', tm(18, 23), loc2(pick(CN_LOCS.slice(0, 7)))),
      T('3 天前 {0}  {1}', tm(12, 22), loc2(pick(CN_LOCS.slice(0, 7)))),
    ];
    spec.issues.push({
      pairs: [['log.last', 'dv.归属']],
      title: '登录地不符', sub: T('上次登录：{0}', cl),
      ask: [['C', '这台设备最近在哪用的？'], nervous(['……一直在家啊。', '……出差了，刚回来。'])],
    });
    spec.reason = '登录地与归属地不符';
    spec.hint = '提示：登录小票显示这台设备一直在大陆';
  }
  }
  if (!kinds.includes('valid')) {
    spec.ok = ['deny', 'detain'];
    if (!kinds.includes('cnip')) spec.quiz = 'cn';
    if (!spec.react.deny) spec.react = { deny: [['E', pick(['……', '可恶。', '我还会回来的。', '这都能看出来？']), { expr: 'sad' }]] };
  }
  // 无尽模式：所有人都有登录记录可查（点设备卡 IP 打印）。默认与归属地一致，只有 logins 缺陷才是大陆登录地
  if (day >= 7 && !spec.logins) {
    const loc2 = (s) => s.split(' · ').slice(0, 2).join(' · ');
    const tm = (a, b) => `${String(rint(a, b)).padStart(2, '0')}:${String(rint(10, 59)).padStart(2, '0')}`;
    const lg = loc2(loc);
    spec.logins = [
      T('今天 {0}  {1}', tm(7, 11), lg),
      T('昨天 {0}  {1}', tm(18, 23), lg),
      T('3 天前 {0}  {1}', tm(12, 22), lg),
    ];
  }
  spec.docs = [{ key: 'pp', doc: pp }, { key: 'dv', doc: device2(ip, loc, tz, lang, null, day >= 7 ? (net || '家宽') : net) }];
  if (day >= 3) spec.docs.push({ key: 'ac', doc: accountCard(pay, bill, phone) });
  return spec;
}

// 随机路人从立绘池里不重复地抽
let POOL_LEFT = [];
function takePoolPerson() {
  if (!POOL_LEFT.length) POOL_LEFT = shuffle(Object.keys(ASSETS.people).filter((k) => !ASSETS.people[k].scripted));
  return POOL_LEFT.pop();
}

const FLAWS = { 2: ['tz', 'lang', 'cnip', 'hidden'], 3: ['tz', 'lang', 'cnip', 'hidden', 'virtual', 'oregon', 'sms'] };
FLAWS[4] = FLAWS[3].concat(['cat', 'keys']);
FLAWS[5] = FLAWS[4];
FLAWS[6] = FLAWS[4].concat(['photo']);
for (let d = 7; d <= 14; d++) FLAWS[d] = FLAWS[6].concat(['hosting', 'logins']);

// ———————————————— 无尽模式 ————————————————
// 队伍永远补不满：每处理一个人就按当前强度继续生成，判错 3 次被调岗。
// 等级越高，合规旅客越少，还会出现“一票多缺陷”和黑话快剪 / 蒸馏大军波次。

const ENDLESS_FLAWS = ['tz', 'lang', 'cnip', 'hidden', 'virtual', 'oregon', 'sms', 'cat', 'keys', 'photo', 'hosting', 'logins'];

function endlessEntrant(level) {
  if (Math.random() < 0.09) return randomFishEntrant(pick(FISH_KINDS));   // 大肥鱼常驻：约每 11 人来一次
  const validP = Math.max(0.22, 0.5 - level * 0.008);
  if (Math.random() < validP) return randomEntrant(7, 'valid');
  const pool = shuffle(ENDLESS_FLAWS.slice());
  const kinds = pool.slice(0, level >= 12 && Math.random() < 0.35 ? 2 : 1);
  return randomEntrant(7, kinds);
}

function buildEndlessQueue() {
  return Array.from({ length: 4 }, (_, i) => endlessEntrant(i));
}

// 处理完一个人后调用：把队伍补到 4 个以上，每 8 人插入一次波次事件
function topUpEndless() {
  if (B.total >= 6 && B.total % 8 === 0) B.queue.push({ type: B.total % 16 === 0 ? 'clones' : 'rush' });
  while (B.queue.length - B.idx < 4) B.queue.push(endlessEntrant(B.total));
}

function flawed(day, n) { return shuffle(FLAWS[day].slice()).slice(0, n).map((k) => randomEntrant(day, k)); }

// 当天的队伍：14 天的调度在 plot.js（plotBuildQueue）
function buildQueue(day) {
  if (!S.endless) return plotBuildQueue(day);
  POOL_LEFT = [];
  const R = (kind) => randomEntrant(day, kind);
  if (day === 1) {
    const f = day1Fixed(), fs = fishDay1();
    return [f.grandpa, R('valid'), f.hk, R(Math.random() < 0.5 ? 'valid' : 'cn'), f.jorji, R('valid'), fs.fish];
  }
  if (day === 2) {
    const f = day2Fixed(), fs = fishDay2(), x = flawed(2, 2);
    return [f.john, R('valid'), f.brown, x[0], f.emily, fs.fish, f.jorji, R('valid'), x[1]];
  }
  if (day === 3) {
    const f = day3Fixed(), fs = fishDay3(), x = flawed(3, 2);
    return [f.tom, R('valid'), f.alex, x[0], f.carpool, f.jorji, fs.fish, R('valid'), x[1]];
  }
  if (day === 4) {
    const f = day4Fixed(), fs = fishDay4(), x = flawed(4, 2);
    return [f.cat, R('valid'), f.v50, { type: 'rush' }, x[0], f.jorji, fs.fish, f.hood, R('valid'), x[1]];
  }
  if (day === 5) {
    const f = day5Fixed(), fs = fishDay5(), x = flawed(5, 1);
    return [f.sg, f.relay, fs.fish, { type: 'clones' }, f.mike, x[0], f.grandma, R('valid')];
  }
  const f = day6Fixed(), fs = fishDay6();
  return [f.jorji, R('valid'), R(pick(FLAWS[6])), R('hidden'), fs.fish, f.author];
}

// 黑话快剪：说中文黑话的拒绝，说人话的放行
const RUSH = [
  { person: 'SLANG0', line: '家人们谁懂啊', ok: 'deny' },
  { person: 'pool', line: 'Have a nice day!', ok: 'approve' },
  { person: 'SLANG1', line: 'yyds', ok: 'deny' },
  { person: 'SLANG2', line: '绝绝子', ok: 'deny' },
  { person: 'pool', line: 'Thanks, man.', ok: 'approve' },
  { person: 'SLANG3', line: '老板说今晚必须上线', ok: 'deny' },
];
