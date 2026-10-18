'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const qa = require('../qa');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'll-qa-'));

function w(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
}

// record：2026-07-29 两个小时文件
w(path.join(tmp, '2026-07', '2026-07-29-10.json'), {
  date: '2026-07-29',
  hour: 10,
  records: [
    { timestamp: '2026-07-29T10:00:00+08:00', activity: '用户在开发 LifeLens 项目，使用 VS Code 写代码', sentences: ['开发 LifeLens', '写代码'] },
    { timestamp: '2026-07-29T10:20:00+08:00', activity: '继续开发 LifeLens，调试截屏模块', sentences: ['开发 LifeLens'] },
  ],
});
w(path.join(tmp, '2026-07', '2026-07-29-11.json'), {
  date: '2026-07-29',
  hour: 11,
  records: [{ timestamp: '2026-07-29T11:00:00+08:00', activity: '看视频放松，B站', sentences: ['看视频'] }],
});

// summary：2026-07-29
w(path.join(tmp, '2026-07', 'summaries-2026-07-29.json'), {
  date: '2026-07-29',
  summaries: {
    '2026-07-29-10-00': { bucket: '2026-07-29-10-00', startTime: '2026-07-29T10:00:00Z', project: '开发 LifeLens', category: '工作', description: '用户在本窗口持续开发 LifeLens 项目，编写截屏与录入模块代码。', software: ['VS Code', '终端'] },
    '2026-07-29-11-00': { bucket: '2026-07-29-11-00', startTime: '2026-07-29T11:00:00Z', project: '看B站', category: '娱乐', description: '用户观看 B 站视频放松。', software: ['浏览器'] },
  },
});

// diary：2026-07-29
w(path.join(tmp, '2026-07', 'diaries-2026-07-29.json'), {
  date: '2026-07-29',
  status: 'ok',
  brief: '今天主要开发 LifeLens，晚上看了视频。',
  mainItems: ['开发 LifeLens 截屏模块', '调试录入逻辑', '晚上看 B 站视频'],
  highlights: ['完成了截屏落盘'],
  suggestions: ['注意休息'],
  tips: '多喝水',
  todos: [],
});

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + msg);
  } else {
    fail++;
    console.error('  ✗ ' + msg);
  }
}

// searchSource：record 命中
const r1 = qa.searchSource(tmp, 'record', '2026-07-29', '2026-07-29', ['LifeLens']);
assert(r1.length >= 2, 'record 搜索 "LifeLens" 命中 >=2 条');
assert(r1.every((x) => x._source === 'record'), 'record 搜索只返回 record 源');

// summary 命中
const r2 = qa.searchSource(tmp, 'summary', '2026-07-29', '2026-07-29', ['LifeLens']);
assert(r2.length === 1 && r2[0].project === '开发 LifeLens', 'summary 搜索命中项目名');

// diary 命中
const r3 = qa.searchSource(tmp, 'diary', '2026-07-29', '2026-07-29', ['LifeLens']);
assert(r3.length === 1 && r3[0]._source === 'diary', 'diary 搜索命中');

// 无命中
const r4 = qa.searchSource(tmp, 'record', '2026-07-29', '2026-07-29', ['完全不存在的关键词xyz']);
assert(r4.length === 0, '无命中返回空数组');

// 跨天范围（含无数据日不报错）
const r5 = qa.searchSource(tmp, 'summary', '2026-07-28', '2026-07-29', ['LifeLens']);
assert(r5.length === 1, '跨天范围（含无数据日）正确返回');

// 单查询条数上限
const big = [];
for (let i = 0; i < 200; i++) {
  big.push({
    timestamp: `2026-07-29T10:${String(i % 60).padStart(2, '0')}:00+08:00`,
    activity: '开发 LifeLens 第' + i + '次',
    sentences: ['开发 LifeLens'],
  });
}
w(path.join(tmp, '2026-07', '2026-07-29-12.json'), { date: '2026-07-29', hour: 12, records: big });
const r6 = qa.searchSource(tmp, 'record', '2026-07-29', '2026-07-29', ['LifeLens']);
assert(r6.length <= 40, '单查询返回条数受 PER_QUERY_LIMIT(40) 限制');

// 空关键词 = 全量匹配（开放式回顾问题“我最近在干什么”的退路，修复前会返回 []）
const r7 = qa.searchSource(tmp, 'summary', '2026-07-29', '2026-07-29', []);
assert(r7.length === 2, '空关键词返回该范围全部 summary（全量匹配）');

// parsePlan：允许空 keywords（全量回顾），不再强制至少 1 个关键词
const p0 = qa.parsePlan('{"queries":[{"source":"summary","from":"2026-07-29","to":"2026-07-29","keywords":[]}],"done":false}');
assert(p0.queries.length === 1 && p0.queries[0].keywords.length === 0 && p0.done === false, 'parsePlan 允许空 keywords（全量）query');

// parsePlan：正常
const p1 = qa.parsePlan('{"queries":[{"source":"summary","from":"2026-07-20","to":"2026-07-29","keywords":["LifeLens"]}],"done":false}');
assert(p1.queries.length === 1 && p1.done === false, 'parsePlan 正常解析且 done=false');

// parsePlan：```json 围栏 + done=true
const p2 = qa.parsePlan('```json\n{"queries":[],"done":true}\n```');
assert(p2.done === true && p2.queries.length === 0, 'parsePlan 处理 ```json 围栏且 done=true');

// parsePlan：非法源/日期 → 过滤后无有效 query → 视为 done
const p3 = qa.parsePlan('{"queries":[{"source":"bogus","from":"x","to":"y","keywords":["a"]}],"done":false}');
assert(p3.queries.length === 0 && p3.done === true, 'parsePlan 过滤非法源且无有效 query 时 done=true');

// parsePlan：乱码
const p4 = qa.parsePlan('这完全不是 JSON 的回答文本');
assert(p4.done === true && p4.queries.length === 0, 'parsePlan 对乱码返回 done 空查询');

// dedupe
const dup = qa.dedupe([...r1, ...r1]);
assert(dup.length === r1.length, 'dedupe 去除重复条目');

// buildAnswerContext 截断
const huge = [];
for (let i = 0; i < 1000; i++) huge.push({ _source: 'record', _ts: '2026-07-29T10:00:00Z', timestamp: '2026-07-29T10:00:00Z', text: 'x'.repeat(100) });
const ctx = qa.buildAnswerContext(huge);
assert(ctx.length <= 20000 + 1000, 'buildAnswerContext 截断不超过上限');

// summarizeCollected
const sm = qa.summarizeCollected(r2);
assert(sm.includes('summary') && sm.includes('2026-07-29'), 'summarizeCollected 含源类型与日期');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nqa 冒烟测试：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
