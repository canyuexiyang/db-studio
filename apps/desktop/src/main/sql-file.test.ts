/**
 * T41：SQL 文件读写纯逻辑的单元测试。
 *
 * 🔴 每条「不会发生 X」都配一条「会触发 X」的对照 ——
 *    否则 `detectExternalChange` 返回 'none' 的实现（什么都不做）能全绿。
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeSqlBytes,
  detectExternalChange,
  writeBackNote,
  readSqlFile,
  writeSqlFile,
  statSqlFile,
  SQL_FILE_MAX_BYTES,
  type SqlFileEncoding,
} from './sql-file.js';

function bytesOf(...parts: (number[] | Uint8Array)[]): Uint8Array {
  const all: number[] = [];
  for (const p of parts) all.push(...p);
  return new Uint8Array(all);
}

/** UTF-8 编码一段文本（不带 BOM） */
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

const SQL = 'SELECT * FROM `order` WHERE id > 10;';

describe('T41 编码探测与解码', () => {
  it('干净 UTF-8（无 BOM）：不回退、不提示', () => {
    const r = decodeSqlBytes(utf8(SQL));
    expect(r.text).toBe(SQL);
    expect(r.encoding).toBe('utf-8');
    expect(r.bom).toBe(false);
    expect(r.fallback).toBe(false);
    // 对照：回退路径一定带 note，这里必须为 null
    expect(r.note).toBeNull();
  });

  it('对照：带 BOM 的 UTF-8 走 BOM 分支，且 BOM 不出现在正文里', () => {
    const r = decodeSqlBytes(bytesOf([0xef, 0xbb, 0xbf], utf8(SQL)));
    expect(r.encoding).toBe('utf-8-bom');
    expect(r.bom).toBe(true);
    // 证伪点：忘了剥 BOM 的话首字符会是 U+FEFF
    expect(r.text.startsWith('﻿')).toBe(false);
    expect(r.text).toBe(SQL);
  });

  it('UTF-16LE 带 BOM：按 LE 解出原文', () => {
    // "AB" 的 UTF-16LE 字节
    const r = decodeSqlBytes(bytesOf([0xff, 0xfe], [0x41, 0x00, 0x42, 0x00]));
    expect(r.encoding).toBe('utf-16le');
    expect(r.bom).toBe(true);
    expect(r.text).toBe('AB');
  });

  it('非 UTF-8 的中文（GBK 字节）：按 GB18030 回退并给出中文说明', () => {
    // 「中文」的 GBK 编码
    const gbk = bytesOf([0xd6, 0xd0, 0xce, 0xc4]);
    const r = decodeSqlBytes(gbk);
    expect(r.fallback).toBe(true);
    expect(r.encoding).toBe('gb18030');
    expect(r.text).toBe('中文');
    // 证伪点：宽松 UTF-8 解码会把非法字节换成 U+FFFD —— 那才是「乱码」
    expect(r.text.includes('�')).toBe(false);
    expect(r.note).toContain('UTF-8');
  });

  it('既非 UTF-8 也非 GB18030：Latin-1 兜底，绝不抛异常', () => {
    // 0xFF 在 UTF-8 与 GB18030 里都是非法字节
    const r = decodeSqlBytes(bytesOf([0xff, 0x41, 0x42]));
    expect(r.encoding).toBe('latin1');
    expect(r.fallback).toBe(true);
    expect(r.text.length).toBe(3);
    expect(r.note).toContain('Latin-1');
  });

  it('无 BOM 的 UTF-16LE 特征（奇数下标全 0）：判为 UTF-16LE 而不是乱码', () => {
    const r = decodeSqlBytes(bytesOf([0x41, 0x00, 0x42, 0x00, 0x43, 0x00, 0x44, 0x00]));
    expect(r.encoding).toBe('utf-16le');
    // 对照：干净 UTF-8 不该被误判成 UTF-16
    expect(decodeSqlBytes(utf8('ABCD')).encoding).toBe('utf-8');
    expect(r.text).toBe('ABCD');
  });

  it('空文件：空串 + utf-8，不回退', () => {
    const r = decodeSqlBytes(new Uint8Array(0));
    expect(r.text).toBe('');
    expect(r.encoding).toBe('utf-8');
    expect(r.fallback).toBe(false);
  });
});

describe('T41 写回提醒', () => {
  it('UTF-8 系写回无需提醒', () => {
    expect(writeBackNote('utf-8')).toBeNull();
    expect(writeBackNote('utf-8-bom')).toBeNull();
  });

  it('非 UTF-8 系写回必须提醒（字节会变）', () => {
    const encodings: SqlFileEncoding[] = ['utf-16le', 'utf-16be', 'gb18030', 'latin1'];
    for (const e of encodings) {
      expect(writeBackNote(e), `${e} 缺少写回提醒`).toContain('UTF-8');
    }
  });
});

describe('T41 外部覆盖冲突判定', () => {
  const base = { mtimeMs: 1000, size: 100 };

  it('没有基线（首次保存 / 另存为）：不比较，直接放行', () => {
    expect(detectExternalChange(null, base)).toBe('none');
  });

  it('戳一致：没变', () => {
    expect(detectExternalChange(base, { mtimeMs: 1000, size: 100 })).toBe('none');
    // 亚毫秒精度差不该算变化（macOS 的 mtime 带纳秒）
    expect(detectExternalChange(base, { mtimeMs: 1000.7, size: 100 })).toBe('none');
  });

  it('mtime 变了：判定为已改（对照：上面同戳是 none）', () => {
    expect(detectExternalChange(base, { mtimeMs: 2000, size: 100 })).toBe('changed');
  });

  it('mtime 没变但 size 变了：也算已改（mtime 精度不足时的第二证据）', () => {
    expect(detectExternalChange(base, { mtimeMs: 1000, size: 999 })).toBe('changed');
  });

  it('文件已不存在：missing（不是 none —— 那是「可以放心覆盖」）', () => {
    expect(detectExternalChange(base, null)).toBe('missing');
  });
});

describe('T41 真文件读写', () => {
  function tmpFile(name: string, content: Uint8Array): string {
    const dir = mkdtempSync(join(tmpdir(), 'dbstudio-sqlfile-'));
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  }

  it('读 UTF-8 文件：拿到原文与文件戳', async () => {
    const p = tmpFile('a.sql', utf8(SQL));
    const r = await readSqlFile(p);
    expect(r.text).toBe(SQL);
    expect(r.stamp.size).toBe(utf8(SQL).length);
    expect(r.fallback).toBe(false);
  });

  it('读 GBK 文件：拿到中文而不是乱码', async () => {
    const p = tmpFile('gbk.sql', bytesOf([0xd6, 0xd0, 0xce, 0xc4]));
    const r = await readSqlFile(p);
    expect(r.text).toBe('中文');
    expect(r.note).not.toBeNull();
  });

  it('读不存在的文件：抛 NOT_FOUND（不能静默返回空串）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbstudio-sqlfile-'));
    await expect(readSqlFile(join(dir, 'nope.sql'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('超过 8MB 的文件拒绝打开（编辑器不是给大文件用的）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbstudio-sqlfile-'));
    const p = join(dir, 'big.sql');
    writeFileSync(p, Buffer.alloc(SQL_FILE_MAX_BYTES + 1, 0x41));
    await expect(readSqlFile(p)).rejects.toMatchObject({ code: 'VALIDATION' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('写入后内容就是写的文本，且 stal 判定能发现「刚被写过」', async () => {
    const p = tmpFile('w.sql', utf8('old'));
    const before = await statSqlFile(p);
    const text = '-- 新的内容\nSELECT 1;';
    const stamp = await writeSqlFile(p, text);
    expect(readFileSync(p, 'utf8')).toBe(text);
    expect(stamp.size).toBe(new TextEncoder().encode(text).length);
    // 证伪点：如果根本没写，前后戳一致 → 判定会是 'none'
    expect(detectExternalChange(before, stamp)).toBe('changed');
    // 写完再取一次戳应与返回值一致（保存后基线要更新成新的）
    expect(detectExternalChange(stamp, await statSqlFile(p))).toBe('none');
  });

  it('原子写不留临时文件', async () => {
    const p = tmpFile('t.sql', utf8('x'));
    await writeSqlFile(p, 'y');
    expect(readFileSync(p, 'utf8')).toBe('y');
    expect(existsSync(`${p}.dbstudio-${process.pid}.tmp`)).toBe(false);
  });
});
