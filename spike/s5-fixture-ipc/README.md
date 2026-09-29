# S5 — 1000 万行 MySQL fixture + 列式 IPC 首屏实测

Spike S5（决策性）：验证「Docker MySQL 8 + 1000 万行种子」能否快速造出，以及「列式 ArrayBuffer 传输 + 首屏渲染」能否达到 PRD 性能预算。

> 仅限本目录产物，请勿修改 `docs/` 下任何文件。

## 1. 起 fixture（Docker MySQL 8，arm64）

依赖：Docker（已实测 29.4.0，含 `mysql:8.0` arm64 镜像）。**不要碰其它已运行容器**（nginx/mongo/redis/postgres/mysql-local 各自占用端口）。

```bash
cd spike/s5-fixture-ipc
docker compose up -d            # 容器名 dbstudio-mysql，宿主 13306 -> 容器 3306
docker compose ps               # 等 STATUS=healthy
```

- 宿主端口：**13306**（避开已有的 mysql-local:3308）
- root 密码：`dbstudio_local_2026`（本地测试用，写进本文件与脚本）
- **named volume：`dbstudio_mysql_data`** —— fixture 造完后卷保留，后续所有性能测试都复用这一份（停止容器不会丢数据）：
  ```bash
  docker compose down           # 停容器，保留卷
  docker compose up -d          # 再次启动，数据仍在
  docker volume inspect dbstudio_mysql_data
  ```
- 配置要点：`innodb_buffer_pool_size=2G`、`innodb-log-file-size=512M`；种子阶段会话级 `innodb_flush_log_at_trx_commit=2` + `sync_binlog=0` 加速写入。

## 2. 灌种子数据（首次，约 10~20 分钟）

```bash
cd spike/s5-fixture-ipc
npm i mysql2                    # 仅本目录安装，切勿在仓库根目录 npm install
node seed/seed.mjs              # 建库 bench / big_table 1000万行 / 索引 / 边界值 / no_key_table 5万行
```

产出：
- `bench.big_table`：1000 万行，列含 `id BIGINT PK / name / email / status / city / amount DECIMAL(12,2) / score DOUBLE / qty INT / flag TINYINT(1) / created_at DATETIME(6) / payload JSON / deleted_at DATETIME(6) NULL`；二级索引 `idx_status / idx_created_at / idx_city`。
- `bench.no_key_table`：5 万行，**无主键无唯一键**（供「无唯一键→网格只读」红线测试）。
- 边界值行（id `9007199254740993/994/995`）：测 BIGINT>2^53、DATETIME(6) 微秒、JSON 内大整数、DECIMAL 字符串、nullMask。

## 3. 跑 benchmark

```bash
node bench-ipc.mjs              # 输出摘要并打印，原始数据写入 raw/bench-raw.json
```

脚本做三件事：
1. **对照**：同批数据编码成列式 `ArrayBuffer` vs `JSON.stringify/parse`，量编码 ms / 体积 / 解码 ms（每种跑 7 次取 P50）。
2. **端到端链路分解**：连接获取 + 服务端执行 `SELECT * FROM big_table LIMIT 3000` + 列式编码 + 模拟 IPC(零拷贝)解码可视区 40 行，对 PRD「表首屏 ≤1000ms」；另测 1 万行对「首行渲染 ≤500ms」、ORDER BY created_at 对「排序 ≤1500ms」。
3. **数据正确性抽查**：4 项边界值（BIGINT 精度 / 微秒 / JSON 大整数 / DECIMAL 字符串）+ nullMask。

> 渲染侧解码用 Node 模拟（真实在 Electron 里跑属 S1 范畴）。真实 IPC 走 `postMessage(payload, transferList)` 零拷贝，transfer 耗时≈0，故链路里只计「编码 + 解码 40 行」。

## 4. 复现步骤（给别人照抄）

```bash
cd spike/s5-fixture-ipc
docker compose up -d && sleep 20      # 等 MySQL healthy
npm i mysql2
node seed/seed.mjs                    # 造 fixture（保留 volume）
node bench-ipc.mjs                    # 出实测数字 -> 看 RESULTS.md
```

## 5. 关键约定（来自 TECH-REVIEW §2.2 / §4.4）

- mysql2 连接参数固定：`supportBigNumbers/bigNumberStrings/dateStrings/jsonStrings:true`、`decimalNumbers:false`、`timezone:'local'`、`multipleStatements:false`、`rowsAsArray:true`。
- 列式形态：数值列 `Float64Array/BigInt64Array/Int32Array + nullMask(Uint8Array)`；字符串列 `Uint32Array offsets + UTF-8 Uint8Array`，渲染侧按需 `TextDecoder.decode` 可视区。
