import { describe, expect, it } from 'vitest';
import { defaultConnectionConfig, validateConnectionConfig } from '@dbstudio/core-connection';
import { duplicateConnectionName, duplicateSaveConfig, hasStoredSecret } from './duplicate';

/**
 * P1-8 创建副本 / 已保存密码占位。
 *
 * 每条断言都对着一个"会安静出事"的写法：
 *  · `hasStoredSecret('')` —— 主进程把密文剥成空串。判 `length > 0` 的话，
 *    编辑既有连接时占位不显示、保存按钮被禁用（用户被迫重输密码）。
 *  · `duplicateSaveConfig().id === ''` —— 留着源 id 走 update，原连接被覆盖。
 *  · 副本的密文占位必须是 null —— `''` 不是密文，拿它当密文存下去这条连接永远连不上。
 */

describe('hasStoredSecret —— 密文占位判定', () => {
  it("空串也算「已存过」（主进程就是这样剥的）", () => {
    expect(hasStoredSecret('')).toBe(true);
  });

  it('null / undefined 表示「没有」', () => {
    expect(hasStoredSecret(null)).toBe(false);
    expect(hasStoredSecret(undefined)).toBe(false);
  });

  it('真实密文（非空串）当然算已存', () => {
    expect(hasStoredSecret('YWJjZGVm')).toBe(true);
  });
});

describe('duplicateConnectionName —— 副本命名', () => {
  it('默认加「副本」后缀', () => {
    expect(duplicateConnectionName('生产-订单库', [])).toBe('生产-订单库 副本');
  });

  it('重名时递增，取第一个空位', () => {
    expect(duplicateConnectionName('a', ['a 副本'])).toBe('a 副本 2');
    expect(duplicateConnectionName('a', ['a 副本', 'a 副本 2'])).toBe('a 副本 3');
  });

  it('中间空位优先（删过一条副本后再复制不该一路涨到 4）', () => {
    expect(duplicateConnectionName('a', ['a 副本', 'a 副本 3'])).toBe('a 副本 2');
  });

  it('只比同名的副本，别的连接名不干扰', () => {
    expect(duplicateConnectionName('a', ['b 副本', 'a', '生产'])).toBe('a 副本');
  });
});

describe('duplicateSaveConfig —— 副本提交的配置', () => {
  const source = defaultConnectionConfig({
    id: 'conn-1',
    name: '生产-订单库',
    host: '10.0.0.9',
    port: 3307,
    user: 'reader',
    // 渲染层能看到的只有占位符，不是密文
    passwordEnc: '',
    defaultDatabase: 'orders',
    group: '生产',
    readOnly: true,
    promptEveryTime: false,
    ssh: {
      enabled: true,
      host: 'jump.example.com',
      port: 22,
      user: 'ops',
      authType: 'password',
      passwordEnc: '',
      privateKeyPath: null,
      passphraseEnc: '',
    },
  });

  it('🔴 id 必须清空 —— 否则 backend 走 update，把原连接覆盖掉', () => {
    expect(duplicateSaveConfig(source).id).toBe('');
  });

  it('🔴 密文占位必须清成 null（空串不是密文）', () => {
    const cfg = duplicateSaveConfig(source);
    expect(cfg.passwordEnc).toBeNull();
    expect(cfg.ssh.passwordEnc).toBeNull();
    expect(cfg.ssh.passphraseEnc).toBeNull();
  });

  it('除密码外全部字段原样带过去', () => {
    const cfg = duplicateSaveConfig(source);
    expect(cfg.name).toBe('生产-订单库');
    expect(cfg.host).toBe('10.0.0.9');
    expect(cfg.port).toBe(3307);
    expect(cfg.user).toBe('reader');
    expect(cfg.defaultDatabase).toBe('orders');
    expect(cfg.group).toBe('生产');
    expect(cfg.readOnly).toBe(true);
    expect(cfg.ssh.enabled).toBe(true);
    expect(cfg.ssh.host).toBe('jump.example.com');
    expect(cfg.ssh.authType).toBe('password');
  });

  it('不改动源对象（树里的原连接不能被副本顺手改掉）', () => {
    duplicateSaveConfig(source);
    expect(source.id).toBe('conn-1');
    expect(source.passwordEnc).toBe('');
    expect(source.ssh.passwordEnc).toBe('');
  });

  it('清掉占位后校验会报「没有密码」—— 所以真密文必须由主进程复制', () => {
    /**
     * 这条断言把"为什么需要 copySecretsFrom"钉在测试里：
     * 渲染层能提交的最完整状态就是没有密码，主进程如果不复制密文，
     * 副本要么保存失败，要么变成一条永远连不上的连接。
     */
    const issues = validateConnectionConfig(duplicateSaveConfig(source));
    expect(issues.some((i) => i.field === 'password' && i.level === 'error')).toBe(true);
  });
});
