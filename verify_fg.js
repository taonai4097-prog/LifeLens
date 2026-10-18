'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 不依赖 Add-Type：直接用 .NET 把「微信文件资源管理器」的 UTF-8 字节还原成字符串，再 base64，
// 模拟真实 GetWindowText 返回的 .NET 字符串 → base64 → Node 解码 的完整链路。
// 微信文件资源管理器 的 UTF-8 字节：
const bytes = [0xe5,0xbe,0xae,0xe4,0xbf,0xa1,0xe6,0x96,0x87,0xe4,0xbb,0xb6,0xe8,0xb5,0x84,0xe6,0xba,0x90,0xe7,0xae,0xa1,0xe7,0x90,0x86,0xe5,0x99,0xa8];
const arr = bytes.join(',');
const SCRIPT = [
  '$bytes = @(' + arr + ')',
  '$s = [System.Text.Encoding]::UTF8.GetString($bytes)',
  '$b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($s))',
  'Write-Output $b64',
].join('\r\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgtest-'));
const ps1 = path.join(dir, 't.ps1');
fs.writeFileSync(ps1, SCRIPT, 'utf8');

execFile(
  'powershell',
  ['-NoProfile', '-NonInteractive', '-File', ps1],
  { windowsHide: true, timeout: 8000, encoding: 'buffer' },
  (err, stdout, stderr) => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (err) { console.log('ERR:', err.message); return; }
    const b64 = (stdout || Buffer.alloc(0)).toString('utf8').trim();
    const expected = '微信文件资源管理器';
    const decoded = b64 ? Buffer.from(b64, 'base64').toString('utf8') : '';
    console.log('base64    :', b64);
    console.log('解码结果  :', decoded);
    console.log('完全一致? :', decoded === expected ? '✅ 链路OK，base64 修复有效' : '❌ 仍坏');
  }
);
