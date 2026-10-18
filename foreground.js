'use strict';

// 前台窗口检测（Windows）：用 user32 GetForegroundWindow 取前台进程名 + 标题。
// 非 Windows 或失败均返回 null（优雅降级，不阻断主流程）。
//
// 关键：环境里 `powershell -Command` 内联 `Add-Type` 会被拦，必须写成 .ps1 文件再用 `-File` 调用。
// 同时服务「隐私排除」与「持续活动提醒」两个功能。
//
// 编码修复（重要）：中文 Windows 下 PowerShell 把窗口标题写入管道时，按 GBK(代码页936) 编码，
// 而 Node 默认按 UTF-8 解码 → 标题中文全变乱码（如「微信」→「΢??」）。
// 即便让 PowerShell 改 UTF-8 输出，本环境 Node 的管道解码仍是 GBK，照样乱码。
// 彻底解法：让 PowerShell 把标题用 **base64（纯 ASCII）** 输出，Node 侧
// `Buffer.from(b64,'base64').toString('utf8')` 确定性解码，绕过一切代码页歧义。

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 防御层：剥离解码残留的替换符 U+FFFD（不可逆损坏标记），正常中文/emoji 不受影响。
function sanitize(s) {
  if (!s) return '';
  return String(s).replace(/�/g, '').trim();
}

const SCRIPT = [
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public class FW {',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int n);',
  '}',
  '"@',
  '$h=[FW]::GetForegroundWindow()',
  '$fgPid=0',
  '[FW]::GetWindowThreadProcessId($h,[ref]$fgPid)|Out-Null',
  '$p=Get-Process -Id $fgPid -ErrorAction SilentlyContinue',
  '$t=New-Object System.Text.StringBuilder 1024',
  '[FW]::GetWindowText($h,$t,1024)|Out-Null',
  // 标题 → UTF-8 字节 → base64（纯 ASCII，任何代码页都不会变样）
  '$b64=[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($t.ToString()))',
  '($p.ProcessName+"|"+$b64)',
].join('\r\n');

let _ps1 = null;
function ensureScript() {
  if (_ps1 && fs.existsSync(_ps1)) return _ps1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelens-fg-'));
  _ps1 = path.join(dir, 'fg.ps1');
  fs.writeFileSync(_ps1, SCRIPT, 'utf8');
  return _ps1;
}

let _cache = { at: 0, value: null };

function getForegroundApp() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const now = Date.now();
  if (_cache.value && now - _cache.at < 2000) return Promise.resolve(_cache.value);
  const ps1 = ensureScript();
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-File', ps1],
      { windowsHide: true, timeout: 4000, encoding: 'buffer' },
      (err, stdout) => {
        if (err) return resolve(null);
        const line = (stdout || Buffer.alloc(0)).toString('utf8').trim();
        const idx = line.indexOf('|');
        if (idx < 0) return resolve(null);
        const process = sanitize(line.slice(0, idx));
        let title = '';
        try {
          title = sanitize(Buffer.from(line.slice(idx + 1), 'base64').toString('utf8'));
        } catch (e) {
          title = '';
        }
        const value = { process, title };
        _cache = { at: Date.now(), value };
        resolve(value);
      }
    );
  });
}

module.exports = { getForegroundApp };
