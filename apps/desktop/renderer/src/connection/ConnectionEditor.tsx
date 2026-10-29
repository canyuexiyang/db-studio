/**
 * 连接编辑器 —— 新建 / 编辑连接（PRD §6.1）
 *
 * 三条硬约束（改这个文件前先看清楚）：
 *  1. 🔴 **密码绝不落渲染层**。明文密码只在 `password` / `passphrase` 两个
 *     state 里存在一次，随 IPC 发出即弃。UI 上看到的密文字段已被主进程剥成
 *     占位串（有值只代表"已存过"，不代表内容），渲染层拿不到也不该拿到。
 *  2. 🔴 **校验必须用 core-connection 的 `validateConnectionConfig`**，
 *     不要自己写一遍。写两遍必然漂移：一处说"端口非法"，另一处放行了 70000，
 *     用户看到的是主进程抛错，而 UI 说一切正常。
 *  3. 🔴 **私钥只填路径，不读内容**。读文件与权限校验在主进程做
 *     （tunnel-manager），渲染层拿不到 fs。这里只需把路径传下去。
 *
 * 关于 lazy：这个组件体积不小（三个分区的表单），但用户不是每次启动都要改连接，
 * 所以它和 SQL 编辑器一样走 `lazy()` —— 不能进首屏 bundle（S2 硬约束）。
 *
 * 🔴 稳定性陷阱（2026-09-26 真机修复，别退回去）：
 *  `Field` **必须定义在模块层**。之前它定义在 ConnectionEditor 函数体内，
 *  每次按键都产生新的组件类型，React 会把整棵表单子树卸载重挂 ——
 *  后果一是输入法组合（IME）被打断，中文一个字都打不进去；
 *  二是 `autoFocus` 在每次重挂时重新抢焦点，光标永远飞回「连接名」。
 *  判定标准：组件体内不允许出现任何 `const Xxx: React.FC = ...`。
 *
 * 布局（2026-09-27 重排，对齐 TablePlus / Navicat 的表单分区）：
 *  字段按「关联性」分进 .ce-section 卡片 —— 连接信息 / 组织 / 连接选项，
 *  label 上置 + 两列栅格，替代之前 118px 左标签的散乱平铺。
 *  🔴 e2e 依赖 `.ce-tabs`、`.ce-field`（hasText 定位 + 内含 input）、
 *     `data-field` 属性 —— 这些类名与结构语义不能改。
 */

import { useCallback, useMemo, useState } from 'react';
import {
  defaultConnectionConfig,
  validateConnectionConfig,
  hasBlockingError,
  checkPrivateKeyPermissions,
  DEFAULT_PORTS,
  DEFAULT_IDLE_TIMEOUT_MS,
  COLOR_TAGS,
  SUPPORTED_TYPES,
  type ConnectionConfig,
  type DbType,
  type ColorTag,
  type ValidationIssue,
} from '@dbstudio/core-connection';
import { duplicateSaveConfig, hasStoredSecret } from './duplicate';

export interface ConnectionEditorProps {
  /** null = 新建；否则预填这条已有连接（创建副本时传的是源连接） */
  editing: ConnectionConfig | null;
  /**
   * P1-8 创建副本：源连接 id。非空 = 保存为**一条新连接**，且密文由主进程
   * 从源连接按字节复制。
   *
   * 🔴 不能用 `editing.id` 有没有值来区分「编辑」与「副本」：有 id 就是编辑，
   *    副本必须显式带这个标记，否则保存会覆盖原连接。
   */
  duplicateOf?: string | null;
  onCancel: () => void;
  /**
   * 保存。明文密码随这一次调用发给主进程，不入 UI 状态树的任何持久位置。
   * 返回保存后的配置（含主进程生成的 id）；返回 null 表示主进程拒绝
   * （如检测到明文泄漏），此时弹窗保持打开。
   */
  onSave: (input: {
    config: ConnectionConfig;
    password?: string | null;
    passphrase?: string | null;
    promptEveryTime?: boolean;
    /** 创建副本：密文来源连接 id（真密文只在主进程里，渲染层无法代为提交） */
    copySecretsFrom?: string | null;
  }) => Promise<ConnectionConfig | null>;
  /** 测试连接。返回耗时 + 版本 + 原始错误文案 */
  onTest: (input: {
    config: ConnectionConfig;
    password?: string | null;
    passphrase?: string | null;
  }) => Promise<{ ok: boolean; serverVersion: string | null; elapsedMs: number; message: string | null }>;
  /** 弹私钥匙文件的绝对路径（走主进程 dialog，渲染层无 fs） */
  onPickKeyFile: () => Promise<string | null>;
  /** 保存并连接（TablePlus 式保存即连）：保存成功后由宿主发起握手 */
  onConnect?: (cfg: ConnectionConfig) => void;
}

type Tab = 'basic' | 'ssh' | 'ssl';

const TAB_LABELS: Record<Tab, string> = {
  basic: '常规',
  ssh: 'SSH 隧道',
  ssl: 'SSL/TLS',
};

const TYPE_LABELS: Record<DbType, string> = {
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
  redis: 'Redis',
  mongodb: 'MongoDB',
};

const COLOR_LABELS: Record<ColorTag, string> = {
  red: '红（生产）',
  orange: '橙',
  yellow: '黄',
  green: '绿',
  blue: '蓝',
  purple: '紫',
  gray: '灰',
  brown: '棕',
};

/** 是否有已保存的密文 —— 判据在 ./duplicate（'' 占位符 = 已存过，单测钉住） */

/**
 * 表单字段壳 —— 模块层组件，身份稳定，重渲染不会重挂输入框。
 * 校验结论由调用方以 `issues` 传入，组件内按 `field` 自查。
 * 🔴 内联错误只在 touched 后显示：打开即满屏红字既吵又挤占分区卡片
 * （视觉验收两轮抓到），保存禁用逻辑不受影响。
 */
const Field: React.FC<{
  label: string;
  field: string;
  issues: ValidationIssue[];
  hint?: string;
  className?: string;
  touched: boolean;
  children: React.ReactNode;
}> = ({ label, field, issues, hint, className, touched, children }) => {
  const issue = touched ? issues.find((i) => i.field === field) : undefined;
  return (
    <label className={`ce-field${className ? ` ${className}` : ''}`} data-field={field}>
      <span className="ce-label">{label}</span>
      <div className="ce-input">{children}</div>
      {issue ? <span className={`ce-msg ${issue.level}`}>{issue.message}</span> : hint ? <span className="ce-hint">{hint}</span> : null}
    </label>
  );
};

export function ConnectionEditor({
  editing,
  duplicateOf,
  onCancel,
  onSave,
  onTest,
  onPickKeyFile,
  onConnect,
}: ConnectionEditorProps) {
  const isNew = editing === null;
  /** 创建副本：有源就有标记，两者同生同灭（App 用同一个 state 传下来） */
  const isDuplicate = !isNew && typeof duplicateOf === 'string' && duplicateOf.length > 0;

  const [form, setForm] = useState<ConnectionConfig>(() => {
    const base = editing ?? defaultConnectionConfig({ type: 'mysql' });
    /**
     * 编辑时把凭据字段归一成 `string | null`，但**必须保留 '' 这个区分**：
     * 主进程剥密文时，`''` = "存过"，`null` = "没有"。
     *
     * 🔴 早先这里写成 `base.passwordEnc ? base.passwordEnc : null`，'' 被吞成 null ——
     *    于是编辑既有连接时：密码框没有「已保存」占位、校验认为没密码、
     *    保存按钮直接禁用，用户被迫重输一遍谁也记不住的密码。
     *    判据见 ./duplicate 的 hasStoredSecret（单测钉住）。
     */
    const keep = (v: string | null | undefined): string | null => (typeof v === 'string' ? v : null);
    return {
      ...base,
      passwordEnc: keep(base.passwordEnc),
      ssh: {
        ...base.ssh,
        passwordEnc: keep(base.ssh?.passwordEnc),
        passphraseEnc: keep(base.ssh?.passphraseEnc),
      },
    };
  });

  /** 明文密码。只在内存里活到保存/测试那一刻 */
  const [password, setPassword] = useState('');
  const [sshPassword, setSshPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');

  const [showPassword, setShowPassword] = useState(false);
  const [tab, setTab] = useState<Tab>('basic');
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** 用户是否动过表单 —— 决定蒙层点击关闭时要不要确认（防误点丢数据） */
  const [touched, setTouched] = useState(false);
  const markTouched = useCallback(() => setTouched(true), []);

  const patch = useCallback((next: Partial<ConnectionConfig>) => {
    setForm((f) => ({ ...f, ...next }));
    setTestResult(null);
    setTouched(true);
  }, []);

  /**
   * 切换数据库类型：端口还是旧类型的默认值时跟随切换（TablePlus/Navicat 惯例），
   * 用户已改过端口则不动 —— 不覆盖手工输入。
   */
  const patchType = useCallback(
    (type: DbType) => {
      setForm((f) => ({
        ...f,
        type,
        port: f.port === DEFAULT_PORTS[f.type] ? DEFAULT_PORTS[type] : f.port,
      }));
      setTestResult(null);
      setTouched(true);
    },
    [],
  );

  const patchSsh = useCallback((next: Partial<ConnectionConfig['ssh']>) => {
    setForm((f) => ({ ...f, ssh: { ...f.ssh, ...next } }));
    setTestResult(null);
    setTouched(true);
  }, []);

  const patchSsl = useCallback((next: Partial<ConnectionConfig['ssl']>) => {
    setForm((f) => ({ ...f, ssl: { ...f.ssl, ...next } }));
    setTestResult(null);
    setTouched(true);
  }, []);

  // ---------- 校验 ----------

  /**
   * 校验要看【凭据是否可用】，而不是看配置里的密文串本身 ——
   * 于是这里用"已存密文 / 本次输入"合成一个影子配置再交给校验器，
   * 否则新建连接会因为"还没有密文"而永远报"未保存密码"。
   */
  const effective: ConnectionConfig = useMemo(() => {
    const storedPassword = hasStoredSecret(form.passwordEnc);
    const storedSshPassword = hasStoredSecret(form.ssh.passwordEnc);
    const storedPassphrase = hasStoredSecret(form.ssh.passphraseEnc);
    return {
      ...form,
      passwordEnc: storedPassword || password ? 'CIPHER' : null,
      ssh: {
        ...form.ssh,
        passwordEnc: storedSshPassword || sshPassword ? 'CIPHER' : null,
        passphraseEnc: storedPassphrase || passphrase ? 'CIPHER' : null,
      },
    };
  }, [form, password, sshPassword, passphrase]);

  const issues = useMemo(() => validateConnectionConfig(effective), [effective]);
  const blocking = hasBlockingError(issues);

  const errorList = issues.filter((i) => i.level === 'error');
  const warnList = issues.filter((i) => i.level === 'warning');

  // ---------- 动作 ----------

  const onPickKey = useCallback(async () => {
    const p = await onPickKeyFile();
    if (p) patchSsh({ privateKeyPath: p });
  }, [onPickKeyFile, patchSsh]);

  const secretInput = useMemo(
    () => ({
      password: password === '' ? undefined : password,
      passphrase: passphrase === '' ? undefined : passphrase,
    }),
    [password, passphrase],
  );

  const doTest = useCallback(async () => {
    setBusy(true);
    setTestResult(null);
    try {
      const r = await onTest({
        /**
         * 带上 form.id 是有意的：用户没重输密码时（密文读不回来），
         * 主进程会按这个 id 退回**已存密码**去试连。副本沿用源的 id，
         * 于是「测试连接」验证的正是它将要继承的那份密码 —— 与保存后一致。
         */
        config: { ...form, id: form.id || 'unsaved' },
        password: secretInput.password,
        passphrase: secretInput.passphrase,
      });
      // 测试失败要展示【原始错误原文】，不做翻译（PRD §6.1.1 明确要求）
      setTestResult({
        ok: r.ok,
        text: r.ok
          ? `连接成功：${r.serverVersion ?? ''}（${r.elapsedMs}ms）`
          : `连接失败：${r.message ?? '未知错误'}`,
      });
    } catch (e) {
      setTestResult({ ok: false, text: `连接失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }, [onTest, form, secretInput]);

  /**
   * 关闭。表单被动过且不是刚保存成功的路径（busy 后的自动关闭）时，
   * 蒙层/取消都可能丢用户填的一堆东西 —— 先确认再关。
   * 保存成功走 doSave 里的 onCancel（此时表单已落盘），不经过这里。
   */
  const requestClose = useCallback(() => {
    if (touched && !window.confirm('表单有未保存的修改，确定关闭吗？')) return;
    onCancel();
  }, [touched, onCancel]);

  const doSave = useCallback(
    async (connectAfterSave = false) => {
      if (blocking) return;
      setBusy(true);
      setSubmitError(null);
      try {
        const saved = await onSave({
          // 副本：清 id（走新建）+ 清密文占位（'' 不是密文），真密文由主进程复制
          config: isDuplicate ? duplicateSaveConfig(form) : form,
          password: password === '' ? undefined : password,
          passphrase: passphrase === '' ? undefined : passphrase,
          promptEveryTime: form.promptEveryTime,
          copySecretsFrom: isDuplicate ? duplicateOf : null,
        });
        if (saved) {
          // 保存并连接：宿主发起握手（promptEveryTime 会弹密码框，由宿主处理）
          if (connectAfterSave && onConnect) onConnect({ ...form, id: saved.id });
          onCancel();
        }
      } catch (e) {
        // 保存失败必须留在弹窗里 —— 关掉就把用户填的一堆东西丢了
        setSubmitError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [blocking, onSave, form, password, passphrase, onConnect, onCancel, isDuplicate, duplicateOf],
  );

  // ---------- 渲染辅助 ----------

  const keyPermWarn = useMemo(() => {
    if (!form.ssh.enabled || form.ssh.authType !== 'privateKey' || !form.ssh.privateKeyPath) return null;
    // 渲染层拿不到文件 mode（沙箱无 fs），这里只负责把"权限要求"讲清楚，
    // 真正的判定在主进程 tunnel-manager（会拒绝并给 chmod 命令）
    return `私钥文件：${form.ssh.privateKeyPath}（权限必须为 0600，否则 SSH 会拒绝使用）`;
  }, [form.ssh]);

  return (
    <div className="modal-mask" onClick={requestClose}>
      <div className="modal connection-editor" onClick={(e) => e.stopPropagation()}>
        <header>{isNew ? '新建连接' : isDuplicate ? `创建副本 — ${form.name}` : `编辑连接 — ${form.name}`}</header>

        <div className="ce-tabs">
          {(['basic', 'ssh', 'ssl'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {TAB_LABELS[t]}
              {t === 'ssh' && form.ssh.enabled ? <span className="ce-dot" title="已启用隧道" /> : null}
              {t === 'ssl' && form.ssl.enabled ? <span className="ce-dot" title="已启用 SSL" /> : null}
            </button>
          ))}
        </div>

        <div className="body">
          {isDuplicate ? (
            <div className="ce-note" data-testid="ce-duplicate-note">
              正在复制「{editing?.name}」：除密码外的字段已预填。密码经系统钥匙串加密保存、
              读不回来，副本会<strong>沿用原连接已保存的密码</strong>；要换密码请在下方直接输入新密码。
            </div>
          ) : null}
          {tab === 'basic' ? (
            <>
              <section className="ce-section">
                <div className="ce-section-title">连接信息</div>
                <div className="ce-grid">
                  <Field label="连接名" field="name" issues={issues} touched={touched} className="span-2">
                    <input
                      value={form.name}
                      onChange={(e) => patch({ name: e.target.value })}
                      placeholder="如：生产-订单库"
                      autoFocus
                    />
                  </Field>
                </div>
                <div className="ce-grid cols-3">
                  <Field label="数据库类型" field="type" issues={issues} touched={touched}>
                    <select value={form.type} onChange={(e) => patchType(e.target.value as DbType)}>
                      {(Object.keys(TYPE_LABELS) as DbType[]).map((t) => (
                        <option key={t} value={t} disabled={!SUPPORTED_TYPES.has(t)}>
                          {TYPE_LABELS[t]}
                          {SUPPORTED_TYPES.has(t) ? '' : '（即将支持）'}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="主机" field="host" issues={issues} touched={touched}>
                    <input value={form.host} onChange={(e) => patch({ host: e.target.value })} placeholder="127.0.0.1" />
                  </Field>
                  <Field label="端口" field="port" issues={issues} touched={touched}>
                    <input
                      type="number"
                      value={form.port}
                      onChange={(e) => patch({ port: Number(e.target.value) })}
                    />
                  </Field>
                </div>
                <div className="ce-grid">
                  <Field label="用户名" field="user" issues={issues} touched={touched}>
                    <input value={form.user} onChange={(e) => patch({ user: e.target.value })} />
                  </Field>
                  <Field label="密码" field="password" issues={issues} touched={touched}>
                    <div className="ce-secret">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => {
                          setPassword(e.target.value);
                          setTestResult(null);
                          markTouched();
                        }}
                        placeholder={
                          hasStoredSecret(form.passwordEnc)
                            ? isDuplicate
                              ? '沿用原连接已保存的密码（留空即可）'
                              : '已保存，留空表示不修改'
                            : ''
                        }
                      />
                      <button type="button" onClick={() => setShowPassword((v) => !v)} title={showPassword ? '隐藏' : '显示'}>
                        {showPassword ? '隐藏' : '显示'}
                      </button>
                    </div>
                  </Field>
                  <Field label="默认数据库" field="defaultDatabase" issues={issues} touched={touched} hint="留空则连接后展示全部库" className="span-2">
                    <input
                      value={form.defaultDatabase ?? ''}
                      onChange={(e) => patch({ defaultDatabase: e.target.value || null })}
                    />
                  </Field>
                </div>
              </section>

              <section className="ce-section">
                <div className="ce-section-title">组织</div>
                <div className="ce-grid">
                  <Field label="分组" field="group" issues={issues} touched={touched} hint="支持嵌套，如「生产/订单」">
                    <input value={form.group ?? ''} onChange={(e) => patch({ group: e.target.value || null })} />
                  </Field>
                  <Field label="颜色标签" field="colorTag" issues={issues} touched={touched}>
                    <select
                      value={form.colorTag ?? ''}
                      onChange={(e) => patch({ colorTag: (e.target.value || null) as ColorTag | null })}
                    >
                      <option value="">无</option>
                      {COLOR_TAGS.map((c) => (
                        <option key={c} value={c}>
                          {COLOR_LABELS[c]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="备注" field="note" issues={issues} touched={touched} className="span-2">
                    <input value={form.note ?? ''} onChange={(e) => patch({ note: e.target.value || null })} />
                  </Field>
                </div>
              </section>

              <section className="ce-section">
                <div className="ce-section-title">连接选项</div>
                <div className="ce-grid">
                  <label className="ce-check">
                    <input type="checkbox" checked={form.readOnly} onChange={(e) => patch({ readOnly: e.target.checked })} />
                    <span>只读模式（D6）：禁止一切写操作</span>
                  </label>
                  <label className="ce-check">
                    <input
                      type="checkbox"
                      checked={form.promptEveryTime}
                      onChange={(e) => patch({ promptEveryTime: e.target.checked })}
                    />
                    <span>每次连接手动输入密码（不落盘）</span>
                  </label>
                  <Field
                    label="空闲超时（分钟）"
                    field="idleTimeoutMs"
                    issues={issues} touched={touched}
                    /* 0.7.1：默认 10 → 120 分钟。文案必须说清「0 = 不断开」，
                       否则用户不知道这个输入框能为 0 做什么 */
                    hint={`默认 ${DEFAULT_IDLE_TIMEOUT_MS / 60000} 分钟；0 表示永不自动断开。工具会每 60 秒自动保活一次，长时间挂着也能直接查`}
                  >
                    <input
                      type="number"
                      min={0}
                      value={Math.floor(form.idleTimeoutMs / 60000)}
                      onChange={(e) => patch({ idleTimeoutMs: Math.max(0, Number(e.target.value)) * 60000 })}
                    />
                    {form.idleTimeoutMs === 0 ? (
                      <span className="ce-hint ce-hint-warn">
                        不会自动断开：这条连接会一直占着服务端的一个连接名额（长连接请留意数据库的 max_connections）
                      </span>
                    ) : null}
                  </Field>
                </div>
              </section>
            </>
          ) : null}

          {tab === 'ssh' ? (
            <>
              <label className="ce-check prominent">
                <input
                  type="checkbox"
                  checked={form.ssh.enabled}
                  onChange={(e) => patchSsh({ enabled: e.target.checked })}
                />
                <span>通过 SSH 隧道连接（跳板机）</span>
              </label>

              {form.ssh.enabled ? (
                <>
                  <section className="ce-section">
                    <div className="ce-section-title">SSH 服务器</div>
                    <div className="ce-grid">
                      <Field label="SSH 主机" field="ssh.host" issues={issues} touched={touched} className="span-2">
                        <input value={form.ssh.host} onChange={(e) => patchSsh({ host: e.target.value })} placeholder="jump.example.com" />
                      </Field>
                      <Field label="SSH 端口" field="ssh.port" issues={issues} touched={touched}>
                        <input
                          type="number"
                          value={form.ssh.port}
                          onChange={(e) => patchSsh({ port: Number(e.target.value) })}
                        />
                      </Field>
                      <Field label="SSH 用户" field="ssh.user" issues={issues} touched={touched}>
                        <input value={form.ssh.user} onChange={(e) => patchSsh({ user: e.target.value })} />
                      </Field>
                    </div>
                  </section>

                  <section className="ce-section">
                    <div className="ce-section-title">认证</div>
                    <div className="ce-grid">
                      <Field label="认证方式" field="ssh.privateKeyPath" issues={issues} touched={touched} className="span-2">
                        <select
                          value={form.ssh.authType}
                          onChange={(e) => patchSsh({ authType: e.target.value as 'password' | 'privateKey' })}
                        >
                          <option value="privateKey">私钥文件</option>
                          <option value="password">密码</option>
                        </select>
                      </Field>

                      {form.ssh.authType === 'privateKey' ? (
                        <>
                          <Field label="私钥文件路径" field="ssh.privateKeyPath" issues={issues} touched={touched} hint={keyPermWarn ?? undefined} className="span-2">
                            <div className="ce-secret">
                              <input value={form.ssh.privateKeyPath ?? ''} readOnly placeholder="未选择" />
                              <button type="button" onClick={() => void onPickKey()}>
                                选择…
                              </button>
                            </div>
                          </Field>
                          <Field label="私钥口令（passphrase）" field="ssh.passphraseEnc" issues={issues} touched={touched} hint="无口令的私钥可留空" className="span-2">
                            <input
                              type={showPassword ? 'text' : 'password'}
                              value={passphrase}
                              onChange={(e) => {
                                setPassphrase(e.target.value);
                                setTestResult(null);
                                markTouched();
                              }}
                              placeholder={hasStoredSecret(form.ssh.passphraseEnc) ? '已保存，留空表示不修改' : ''}
                            />
                          </Field>
                        </>
                      ) : (
                        <Field label="SSH 密码" field="ssh.passwordEnc" issues={issues} touched={touched} className="span-2">
                          <div className="ce-secret">
                            <input
                              type={showPassword ? 'text' : 'password'}
                              value={sshPassword}
                              onChange={(e) => {
                                setSshPassword(e.target.value);
                                setTestResult(null);
                                markTouched();
                              }}
                              placeholder={hasStoredSecret(form.ssh.passwordEnc) ? '已保存，留空表示不修改' : ''}
                            />
                            <button type="button" onClick={() => setShowPassword((v) => !v)}>
                              {showPassword ? '隐藏' : '显示'}
                            </button>
                          </div>
                        </Field>
                      )}
                    </div>
                  </section>

                  <div className="ce-note">
                    隧道目标为上方「主机 / 端口」所填的数据库地址（跳板机会转发到该地址）。
                    隧道建立超时默认 10 秒；关闭连接时隧道一并释放。
                  </div>
                </>
              ) : (
                <div className="ce-note">未启用隧道时，将直连上方填写的数据库地址。</div>
              )}
            </>
          ) : null}

          {tab === 'ssl' ? (
            <>
              <label className="ce-check prominent">
                <input
                  type="checkbox"
                  checked={form.ssl.enabled}
                  onChange={(e) => patchSsl({ enabled: e.target.checked })}
                />
                <span>启用 SSL/TLS</span>
              </label>

              {form.ssl.enabled ? (
                <section className="ce-section">
                  <div className="ce-section-title">证书</div>
                  <div className="ce-grid">
                    <Field label="CA 证书" field="ssl.caPath" issues={issues} touched={touched} className="span-2">
                      <input value={form.ssl.caPath ?? ''} onChange={(e) => patchSsl({ caPath: e.target.value || null })} placeholder="/path/to/ca.pem" />
                    </Field>
                    <Field label="客户端证书" field="ssl.certPath" issues={issues} touched={touched}>
                      <input value={form.ssl.certPath ?? ''} onChange={(e) => patchSsl({ certPath: e.target.value || null })} placeholder="/path/to/client-cert.pem" />
                    </Field>
                    <Field label="客户端密钥" field="ssl.keyPath" issues={issues} touched={touched}>
                      <input value={form.ssl.keyPath ?? ''} onChange={(e) => patchSsl({ keyPath: e.target.value || null })} placeholder="/path/to/client-key.pem" />
                    </Field>
                  </div>
                  <label className="ce-check">
                    <input
                      type="checkbox"
                      checked={form.ssl.rejectUnauthorized}
                      onChange={(e) => patchSsl({ rejectUnauthorized: e.target.checked })}
                    />
                    <span>校验证书（关闭后连接不安全）</span>
                  </label>
                  {!form.ssl.rejectUnauthorized ? (
                    <div className="ce-note warn">
                      已关闭证书校验：连接可被中间人攻击。仅建议用于自建测试环境。
                    </div>
                  ) : null}
                </section>
              ) : null}
            </>
          ) : null}
        </div>

        {/* 校验错误只在用户动过表单后显示 —— 打开即一排红字既吵又把分区卡片
            挤出可视区（视觉验收抓到；Navicat/TablePlus 同样是保存时才报错）。
            保存禁用逻辑不受影响：blocking 仍由 issues 实时计算。 */}
        {touched && errorList.length > 0 ? (
          <div className="ce-issues ce-msg error">
            {errorList.map((i) => (
              <div key={i.field}>· {i.message}</div>
            ))}
          </div>
        ) : null}
        {touched && warnList.length > 0 ? (
          <div className="ce-issues ce-msg warning">
            {warnList.map((i) => (
              <div key={i.field}>· {i.message}</div>
            ))}
          </div>
        ) : null}
        {submitError ? <div className="ce-issues ce-msg error">保存失败：{submitError}</div> : null}
        {testResult ? (
          <div className={`ce-issues ce-msg ${testResult.ok ? 'ok' : 'error'}`}>{testResult.text}</div>
        ) : null}

        <footer>
          <button onClick={() => void doTest()} disabled={busy || blocking}>
            {busy ? '测试中…' : '测试连接'}
          </button>
          <span className="spacer" />
          <button onClick={requestClose} disabled={busy}>
            取消
          </button>
          <button onClick={() => void doSave()} disabled={busy || blocking}>
            保存
          </button>
          {onConnect ? (
            <button className="primary" onClick={() => void doSave(true)} disabled={busy || blocking} title="保存后立即建立连接">
              保存并连接
            </button>
          ) : (
            <button className="primary" onClick={() => void doSave()} disabled={busy || blocking}>
              保存
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

/** 导出给外部做默认端口提示用 */
export { DEFAULT_PORTS, TYPE_LABELS, checkPrivateKeyPermissions };
