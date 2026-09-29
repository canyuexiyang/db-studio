// S5 fixture seeder — 建库/建表/灌 1000 万行 / 建索引 / 边界值 / no_key_table 5万行
// 运行: node seed/seed.mjs
import mysql from 'mysql2/promise';

const CFG = {
  host: '127.0.0.1',
  port: 13306,
  user: 'root',
  password: 'dbstudio_local_2026',
  database: 'bench',
  // 注意：建存储过程时内部含分号，mysql2 仅在 multipleStatements:true 时才拆分，
  // 这里保持默认 false，把整段 CREATE PROCEDURE 作为单条语句发给服务端解析。
  multipleStatements: false,
  waitForConnections: true,
  connectionLimit: 5,
};

const TOTAL = 10_000_000;
const BATCH = 10_000;

const log = (...a) => console.log(`[seed ${new Date().toISOString()}]`, ...a);

async function main() {
  const pool = mysql.createPool(CFG);
  const conn = await pool.getConnection();

  // 1) 库 & 表
  log('create database / tables ...');
  await conn.query('DROP TABLE IF EXISTS big_table');
  await conn.query('DROP TABLE IF EXISTS no_key_table');
  await conn.query(`
    CREATE TABLE big_table (
      id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name        VARCHAR(64)     NOT NULL,
      email       VARCHAR(128)    NOT NULL,
      status      VARCHAR(16)     NOT NULL,
      city        VARCHAR(32)     NOT NULL,
      amount      DECIMAL(12,2)   NOT NULL,
      score       DOUBLE          NOT NULL,
      qty         INT             NOT NULL,
      flag        TINYINT(1)      NOT NULL,
      created_at  DATETIME(6)     NOT NULL,
      payload     JSON            NULL,
      deleted_at  DATETIME(6)     NULL,
      KEY (status), KEY (created_at), KEY (city)
    ) ENGINE=InnoDB
  `);
  // no_key_table：无主键/无唯一键，供"网格只读"红线测试
  await conn.query(`
    CREATE TABLE no_key_table (
      id          INT          NOT NULL,
      name        VARCHAR(64)  NOT NULL,
      score       INT          NOT NULL,
      created_at  DATETIME     NOT NULL,
      note        VARCHAR(128) NOT NULL
    ) ENGINE=InnoDB
  `);

  // 2) 存储过程：每批 1 万行 INSERT...SELECT（笛卡尔积生成），每批 COMMIT
  log('create stored procedure bench_seed_big_table ...');
  await conn.query('DROP PROCEDURE IF EXISTS bench_seed_big_table');
  await conn.query(`
    CREATE PROCEDURE bench_seed_big_table(IN total_rows BIGINT, IN batch_size INT)
    BEGIN
      DECLARE b INT DEFAULT 0;
      DECLARE batches INT DEFAULT CEIL(total_rows / batch_size);
      WHILE b < batches DO
        INSERT INTO big_table (name, email, status, city, amount, score, qty, flag, created_at, payload, deleted_at)
        SELECT
          CONCAT('user_', b * batch_size + g.seq),
          CONCAT('user', b * batch_size + g.seq, '@example.com'),
          ELT(1 + ((b * batch_size + g.seq) MOD 5), 'active','inactive','pending','banned','trial'),
          ELT(1 + ((b * batch_size + g.seq) MOD 12), 'Beijing','Shanghai','Shenzhen','Guangzhou','Hangzhou','Chengdu','Wuhan','Xian','Nanjing','Chongqing','Suzhou','Tianjin'),
          CAST(((b * batch_size + g.seq) MOD 1000000) / 7.0 AS DECIMAL(12,2)),
          ((b * batch_size + g.seq) MOD 1000) / 13.0,
          (b * batch_size + g.seq) MOD 500,
          (b * batch_size + g.seq) MOD 2,
          TIMESTAMPADD(MICROSECOND, (b * batch_size + g.seq) MOD 1000000, TIMESTAMPADD(DAY, b, '2024-01-01 00:00:00')),
          CONCAT('{"uid":', b * batch_size + g.seq, ',"v":', ((b * batch_size + g.seq) MOD 100), '}'),
          IF((b * batch_size + g.seq) MOD 7 = 0, TIMESTAMPADD(MICROSECOND, (b * batch_size + g.seq) MOD 1000000, TIMESTAMPADD(DAY, b, '2024-02-01 00:00:00')), NULL)
        FROM (
          SELECT (t3.n*1000 + t2.n*100 + t1.n*10 + t0.n) AS seq
          FROM
            (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) t0,
            (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) t1,
            (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) t2,
            (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) t3
        ) g
        WHERE g.seq < batch_size;
        SET b = b + 1;
        COMMIT;
      END WHILE;
    END
  `);

  // 3) 加速批量写入（本地 fixture，牺牲部分持久性换取速度；这两个变量只能 GLOBAL 设置）
  log(`seeding big_table: ${TOTAL} rows in batches of ${BATCH} ...`);
  await conn.query('SET GLOBAL innodb_flush_log_at_trx_commit = 2');
  await conn.query('SET GLOBAL sync_binlog = 0');
  const t0 = performance.now();
  await conn.query('CALL bench_seed_big_table(?, ?)', [TOTAL, BATCH]);
  const seedMs = performance.now() - t0;
  log(`big_table seeded in ${(seedMs / 1000).toFixed(1)}s`);

  // 3.5) 批量插入后再建二级索引（避免增量维护高基数字段索引拖慢写入）
  log('build secondary indexes (status, created_at, city) ...');
  const ti = performance.now();
  await conn.query('CREATE INDEX idx_status ON big_table(status)');
  await conn.query('CREATE INDEX idx_created_at ON big_table(created_at)');
  await conn.query('CREATE INDEX idx_city ON big_table(city)');
  log(`indexes built in ${((performance.now() - ti) / 1000).toFixed(1)}s`);

  // 4) 边界值行（故意放，供正确性抽查）— BIGINT>2^53 / 微秒 / JSON大整数 / DECIMAL字符串 / nullMask
  log('insert boundary rows ...');
  await conn.query(`
    INSERT INTO big_table (id, name, email, status, city, amount, score, qty, flag, created_at, payload, deleted_at) VALUES
    (9007199254740993, 'bigint_user', 'big@example.com',     'active',  'Beijing',  1234567890.12, 3.14159, 42, 1, '2026-09-21 12:34:56.123456', '{"id": 9007199254740993, "name": "x"}', NULL),
    (9007199254740994, 'micro_user',  'micro@example.com',   'pending', 'Shanghai', 0.01,          2.71828, 7,  0, '2026-09-21 12:34:56.654321', '{"small": 1}',                          '2026-09-20 00:00:00.000000'),
    (9007199254740995, 'dec_user',    'dec@example.com',     'banned',  'Shenzhen', 9999999999.99, 1.5,     100,1, '2024-06-15 08:30:00.000000', '{"big": 9007199254740995}',           NULL)
  `);

  // 5) no_key_table 5 万行（笛卡尔积 10^5，取前 5 万）
  log('seed no_key_table (50000 rows) ...');
  await conn.query(`
    INSERT INTO no_key_table (id, name, score, created_at, note)
    SELECT
      g.seq,
      CONCAT('nk_', g.seq),
      g.seq MOD 1000,
      TIMESTAMPADD(SECOND, g.seq, '2024-01-01 00:00:00'),
      CONCAT('note_', g.seq MOD 50)
    FROM (
      SELECT (t4.n*10000 + t3.n*1000 + t2.n*100 + t1.n*10 + t0.n) AS seq
      FROM
        (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) t0,
        (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) t1,
        (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) t2,
        (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) t3,
        (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) t4
    ) g
    WHERE g.seq < 50000
  `);

  // 6) 汇总
  const [[{ big }]] = await conn.query('SELECT COUNT(*) AS big FROM big_table');
  const [[{ nk }]] = await conn.query('SELECT COUNT(*) AS nk FROM no_key_table');
  log(`DONE. big_table=${big}  no_key_table=${nk}`);
  log(`big_table seed time = ${(seedMs / 1000).toFixed(1)}s (excluding index build not needed; indexes already inline)`);

  await conn.release();
  await pool.end();
}

main().catch((e) => { console.error('SEED FAILED:', e); process.exit(1); });
