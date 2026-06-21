# FormStream

给静态网站用的表单后端服务（类似 Formspree / Web3Forms），核心差异点是**原生支持钉钉 / 飞书 / 企业微信通知**。多租户、自助注册，管理员功能整合在同一后台。

> 没有自己的服务器也能收表单：在你的静态网站表单上填一个 `action="https://你的域名/s/<access_key>"`，提交的数据会自动落库，并按你配置的渠道（钉钉/飞书/企业微信群机器人、邮件、通用 webhook）实时推送通知。

## 这个项目能做什么

| 痛点 | FormStream 怎么解决 |
|---|---|
| 静态站没有后端，收不了表单 | 一个 `access_key`，零后端代码，`<form action="...">` 直接指过去就能用 |
| 国内邮件通知到达率差 | 直推钉钉 / 飞书 / 企业微信群机器人，HMAC 加签 |
| 裸 webhook 自己扛限流、加签很麻烦 | 服务端统一加签 + 队列削峰 + 失败指数退避重试 |
| 表单数据没地方存 | 落 Supabase Postgres，后台随时查看、导出 CSV |
| 容易被脏数据/垃圾机器人刷 | 域名白名单 + 蜜罐字段 + Cloudflare Turnstile 人机验证 + 双维度限流 |
| 多用户场景下台账混乱 | 多租户隔离（行级安全 RLS）+ 管理员后台统一管控（用户/表单/用量/审计日志） |

### 核心功能

- **公开表单端点** `POST /s/:access_key`：支持 `multipart/form-data`、`application/x-www-form-urlencoded`、`application/json` 三种提交方式；支持文件上传（落 Cloudflare R2，按套餐限额）
- **多渠道通知**：钉钉 / 飞书（HMAC-SHA256 加签）、企业微信（无加签）、通用 Webhook、邮件（Resend），经 Cloudflare Queue 异步派发，失败自动退避重试
- **反滥用**：域名白名单、蜜罐字段、Turnstile 人机验证（可选）、IP+表单双维度限流
- **用户后台**：注册/登录、表单 CRUD、通知渠道管理（含一键测试）、提交记录查看/删除/导出 CSV、文件下载、用量看板
- **管理员后台**：跨租户用户管理（改套餐/状态/角色、删除）、全局表单检索与强制停用、平台概览（提交趋势、Top 表单、垃圾拦截率）、操作审计日志
- **套餐软限制**：按 free / pro / business 套餐限制表单数、渠道数、月提交量、单文件大小

### 技术栈

| 组件 | 选型 |
|---|---|
| 运行时 | Cloudflare Workers（单 Worker，不用 Pages） |
| 后台界面 | React Router v7（SSR）+ Tailwind CSS |
| API 层 | Hono（公开端点 `/s/*`、用户 API `/api/*`、管理员 API `/api/admin/*`） |
| 数据库/鉴权 | Supabase（Postgres + Auth，行级安全 RLS） |
| 文件存储 | Cloudflare R2 |
| 缓存/限流 | Cloudflare KV |
| 异步通知 | Cloudflare Queues |
| 防滥用 | Cloudflare Turnstile（可选） |
| 邮件 | Resend（可选） |

更详细的架构设计、数据模型、API 设计见 [`docs/FormStream-开发文档.md`](docs/FormStream-开发文档.md)。

---

## 部署指南

下面假设你是**第一次部署这个项目**：刚 Fork/Clone 了仓库，Cloudflare、Supabase 账号都还没配置任何东西。跟着下面的步骤一步一步做，做完就能跑起来。

### 你需要准备

- Node.js 20+、npm
- 一个 **Cloudflare** 账号，已绑定支付方式（R2/KV 首次启用通常需要，即使用量在免费额度内）
- 一个 **Supabase** 账号
- （可选）一个域名、一个 Resend 账号——没有也能先把整个流程跑通，只是邮件通知/自定义域名用不上

### 第 0 步：拉代码、装依赖

```bash
git clone <你 fork 的仓库地址>
cd formstream
npm install
```

---

### 第 1 步：Supabase 端设置

#### 1.1 建项目

1. 打开 [supabase.com](https://supabase.com) → New Project
2. 项目名随意，比如 `formstream`
3. 数据库密码：随机生成一个强密码，存进密码管理工具——**这个项目本身用不到这个密码**（连库走 `supabase-js`/REST API，不走裸 Postgres TCP），只有你要直连数据库做运维时才用得上
4. Region：选离你目标用户最近的区域，建好之后不好迁移，提前想清楚
5. Plan：开发阶段用 Free 没问题；**正式上线前必须升级到 Pro**——Free 档闲置 7 天会自动暂停项目，不适合生产环境

#### 1.2 初始化数据库

打开 Supabase 控制台 → **SQL Editor**，依次粘贴执行下面三段 SQL。

**① 建表**

```sql
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        text not null default 'user'   check (role in ('user','admin')),
  status      text not null default 'active'  check (status in ('active','suspended')),
  plan        text not null default 'free',   -- free / pro / business
  created_at  timestamptz not null default now()
);

create table public.forms (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  name            text not null,
  access_key      text not null unique default encode(gen_random_bytes(16),'hex'),
  allowed_domains text[] not null default '{}',
  is_active       boolean not null default true,
  turnstile_enabled boolean not null default false,
  redirect_url    text,
  spam_protection boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index idx_forms_user on public.forms(user_id);

create table public.notification_channels (
  id          uuid primary key default gen_random_uuid(),
  form_id     uuid not null references public.forms(id) on delete cascade,
  type        text not null check (type in ('dingtalk','feishu','wework','email','webhook')),
  config      jsonb not null,        -- {webhook_url, secret, emails:[], ...}
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index idx_channels_form on public.notification_channels(form_id);

create table public.submissions (
  id          uuid primary key default gen_random_uuid(),
  form_id     uuid not null references public.forms(id) on delete cascade,
  data        jsonb not null,
  files       jsonb not null default '[]',
  ip          inet,
  user_agent  text,
  country     text,
  is_spam     boolean not null default false,
  created_at  timestamptz not null default now()
);
create index idx_sub_form_created on public.submissions(form_id, created_at desc);

create table public.usage (
  user_id     uuid not null references auth.users(id) on delete cascade,
  period      date not null,
  count       integer not null default 0,
  primary key (user_id, period)
);

create table public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references auth.users(id) on delete set null,
  actor_email text,
  action      text not null,
  target_type text not null,
  target_id   text,
  detail      jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index idx_audit_logs_created on public.audit_logs(created_at desc);

-- 注册后自动建 profile
create function public.handle_new_user() returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end; $$;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();
```

**② 开启行级安全（RLS）**

```sql
alter table public.profiles enable row level security;
alter table public.forms enable row level security;
alter table public.submissions enable row level security;
alter table public.notification_channels enable row level security;
alter table public.usage enable row level security;
alter table public.audit_logs enable row level security;

create policy "own profile" on public.profiles
  for select using (auth.uid() = id);

create policy "own forms" on public.forms
  for all using (auth.uid() = user_id);

create policy "own submissions" on public.submissions
  for all using (exists (
    select 1 from public.forms f
    where f.id = submissions.form_id and f.user_id = auth.uid()));

create policy "own channels" on public.notification_channels
  for all using (exists (
    select 1 from public.forms f
    where f.id = notification_channels.form_id and f.user_id = auth.uid()));

create policy "own usage" on public.usage
  for select using (auth.uid() = user_id);

-- audit_logs 不建任何 policy：RLS 默认拒绝所有人，只有 service_role（绕过 RLS）能读写
```

> ⚠️ **跑完务必去 Table Editor 里肉眼确认这 6 张表真的出现了**。Supabase 的 PostgREST schema cache 偶尔会和实际建表状态不同步，SQL 没报错不代表表已经能被 API 访问——如果后面调用接口报 `Could not find the table 'xxx' in the schema cache`（错误码 `PGRST205`），先去 Table Editor 确认表是否存在，再决定要不要重新跑。

**③ 确认触发器生效（可选自查）**

```sql
select tgname from pg_trigger where tgname = 'on_auth_user_created';
```
能查到一行说明触发器建好了——之后每个新注册用户都会自动在 `profiles` 表里生成一条记录。

#### 1.3 Auth 配置

1. Authentication → Providers：确认 **Email** 登录方式已启用（默认就是开的）
2. Authentication → URL Configuration：
   - Site URL：先填 `http://localhost:5173`（本地开发用），部署后再换成正式域名或 `*.workers.dev` 地址
   - Redirect URLs：跟 Site URL 保持一致即可，这个项目没用到第三方 OAuth 回调
3. 邮件模板：用 Supabase 自带的默认模板即可（确认邮件、找回密码邮件），不需要自定义 SMTP
4. 注意 Supabase 自带邮件发送有频率限制（免费档每小时几封），开发阶段频繁注册测试账号容易触发 `email rate limit exceeded`——这是正常现象，等一会儿重试，或者参考下方[故障排查](#故障排查)里用 Admin API 直接建已确认账号的脚本

#### 1.4 拿到三个关键值

Settings → API：

| 名称 | 在哪 | 用途 |
|---|---|---|
| Project URL | Settings → API → Project URL | 填进 `wrangler.json` 的 `vars.SUPABASE_URL`（非机密） |
| Publishable key（旧称 anon key） | Settings → API → API Keys，形如 `sb_publishable_...` | `SUPABASE_ANON_KEY`，验证用户登录态用，非机密 |
| Secret key（旧称 service_role key） | 同上，形如 `sb_secret_...` | `SUPABASE_SERVICE_KEY`，**绕过 RLS 的最高权限密钥，绝密** |

> Supabase 新版控制台把 `anon key` 改名叫 **Publishable key**，`service_role key` 改名叫 **Secret keys**（且支持创建多个，建议给这个项目单独建一个，方便以后单独吊销/轮换）。名字变了，本质没变。

---

### 第 2 步：Cloudflare 端设置

#### 2.1 账号与计费

- R2 / KV 首次使用通常要求账号已绑定支付方式（即使用量在免费额度内）
- **Cloudflare Queues 在 Free 计划下也能直接用**，不需要升级 Paid：Free 档每天 10,000 次 operations 免费、消息保留期固定 24 小时；Paid 计划（$5/月起）每月 100 万次免费、保留期可配到 14 天。开发/早期阶段用 Free 就够

#### 2.2 登录 wrangler

```bash
npx wrangler login
```
会打开浏览器走 OAuth 授权，授权完本地会留一个 token，之后不用每次都登录。

#### 2.3 创建 R2 bucket

```bash
npx wrangler r2 bucket create formstream-uploads
```
（名字可以自己换，但要和下一步 `wrangler.json` 里的 `bucket_name` 保持一致）

#### 2.4 创建 KV namespace

```bash
npx wrangler kv namespace create RATE_LIMIT
```
命令会返回一个 `id`，记下来，下一步要填进 `wrangler.json`。

#### 2.5 创建 Queue

```bash
npx wrangler queues create formstream-notify
```

#### 2.6 （可选）Turnstile 人机验证

1. Cloudflare Dashboard → Turnstile → Add site
2. Domain 填你的正式域名（没有就先填占位域名，部署后再回来改）
3. 拿到 **Site Key**（前端表单页要嵌入用，非机密）和 **Secret Key**（后端校验用，配成 secret `TURNSTILE_SECRET`）
4. 这一步现在跳过也不影响其他功能——但如果某个表单在后台把 "开启 Turnstile" 打开了，而 `TURNSTILE_SECRET` 没配，后端会直接拒绝这次保存（`503 TURNSTILE_UNAVAILABLE`），不会出现"开了但悄悄不生效"的情况

#### 2.7 （可选）自定义域名

1. 域名先加到 Cloudflare（NS 切过来）
2. 部署完 Worker 之后，去 Workers & Pages → 找到 `formstream` → Settings → Domains & Routes → 绑定自定义域名
3. 没有域名也不影响部署，先用 Cloudflare 分配的 `*.workers.dev` 子域名

#### 2.8 （可选）Resend 邮件通知

1. 注册 [resend.com](https://resend.com)
2. Domains → 添加发信域名，按提示在 DNS 里加 SPF/DKIM 记录（域名托管在 Cloudflare 的话直接在 Cloudflare DNS 里加）
3. 拿到 `RESEND_API_KEY`
4. 没有自己验证的域名也能先用默认的 `onboarding@resend.dev` 发件地址跑通流程，正式上线前换成自己验证过的域名

---

### 第 3 步：项目里填好绑定配置

把第 2 步拿到的 R2/KV/Queue 名字和 id，以及第 1 步拿到的 Supabase Project URL，填进项目根目录的 `wrangler.json`：

```jsonc
{
  "name": "formstream",
  "main": "./workers/app.ts",
  "compatibility_date": "2025-10-08",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "upload_source_maps": true,
  "vars": {
    "SUPABASE_URL": "https://你的项目id.supabase.co"
  },
  "r2_buckets": [
    { "bucket_name": "formstream-uploads", "binding": "UPLOADS" }
  ],
  "kv_namespaces": [
    { "binding": "RATE_LIMIT", "id": "你的 KV namespace id" }
  ],
  "queues": {
    "producers": [{ "binding": "NOTIFY_QUEUE", "queue": "formstream-notify" }],
    "consumers": [{ "queue": "formstream-notify", "max_batch_size": 10, "max_retries": 5 }]
  }
}
```

改完之后重新生成类型（这一步在每次改 `wrangler.json` 绑定、或新增/修改路由之后都要做）：

```bash
npm run cf-typegen
```

---

### 第 4 步：配置密钥（Secrets）

项目要用到 5 个密钥，分两套环境配置方式：

| 名称 | 说明 | 必填 |
|---|---|---|
| `SUPABASE_ANON_KEY` | Supabase Publishable key | ✅ |
| `SUPABASE_SERVICE_KEY` | Supabase Secret key，绕过 RLS | ✅ |
| `ADMIN_EMAILS` | 逗号分隔的管理员邮箱，登录时自动提权 | ✅ |
| `RESEND_API_KEY` | 发邮件通知用 | 可选 |
| `TURNSTILE_SECRET` | Turnstile 人机验证密钥 | 可选 |

#### 4.1 本地开发：`.dev.vars`

在项目根目录创建 `.dev.vars`（已经被 `.gitignore` 排除，不会进 git，放心写真实值）：

```
SUPABASE_ANON_KEY=sb_publishable_xxxxx
SUPABASE_SERVICE_KEY=sb_secret_xxxxx
ADMIN_EMAILS=you@example.com
RESEND_API_KEY=re_xxxxx
```

`TURNSTILE_SECRET` 没配的话留空不写就行，代码按可选处理。`npm run dev` 会自动读取这个文件。

#### 4.2 生产环境：`wrangler secret put`

**这一步非常容易漏掉，漏了的后果是：部署成功、页面打开直接报通用错误页（"Oops! An unexpected error occurred."），因为后端拿到的 Supabase key 是 `undefined`。**

`.dev.vars` **只在本地 `npm run dev` 生效**，生产环境的密钥必须单独配置，跟代码、跟 `wrangler.json` 完全无关：

```bash
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler secret put ADMIN_EMAILS
npx wrangler secret put RESEND_API_KEY      # 可选
npx wrangler secret put TURNSTILE_SECRET    # 可选
```

每条命令会交互式提示你输入值（不会回显在终端、不会留在 shell 历史里），粘贴值按回车即可。

确认已经配置了哪些 secret（只能看名字，看不到值）：
```bash
npx wrangler secret list
```
至少要看到 `SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_KEY`、`ADMIN_EMAILS` 三个，否则线上打开就会报错。

---

### 第 5 步：本地跑起来验证一遍

```bash
npm run dev
```

打开 `http://localhost:5173`，走一遍核心流程：

1. 首页能正常打开，看到"登录"/"注册"按钮
2. 用 `ADMIN_EMAILS` 里配的邮箱注册一个账号（注册后可能要去邮箱点确认链接才能登录，这是 Supabase 默认行为）
3. 登录后，确认页面右上角能看到"管理员"标记（说明自动提权逻辑生效）
4. 在后台建一个表单，拿到 `access_key`
5. 用 curl 模拟一次提交：
   ```bash
   curl -X POST http://localhost:5173/s/<access_key> -d "name=test" -H "Accept: application/json"
   ```
6. 回后台确认这条提交记录出现了

本地终端日志里如果看到 `QUEUE formstream-notify 1/1 (...)`，说明通知队列本地也跑通了。

---

### 第 6 步：构建与正式部署

#### 6.1 先跑一次完整检查

```bash
npm run check
```
依次做：`tsc` 类型检查 → `react-router build` 构建 → `wrangler deploy --dry-run` 模拟部署（不会真的发布，只验证配置/绑定是否正确）。三步都过了才放心部署。

#### 6.2 正式部署

```bash
npm run deploy
```
构建并把 Worker 发布到 Cloudflare。命令执行完会打印出访问地址（`https://formstream.<你的账号>.workers.dev`，或你绑定的自定义域名）。

#### 6.3 部署成功的标志

终端输出类似：
```
Uploaded formstream (x.xx sec)
Deployed formstream triggers (x.xx sec)
  https://formstream.<account>.workers.dev
```

---

### 第 7 步：部署后验证清单

部署完别急着收工，按这个清单点一遍：

- [ ] 打开部署地址，首页能正常打开（不是报错页）
- [ ] `/login`、`/register` 页面正常渲染
- [ ] 用管理员邮箱注册/登录，后台显示"管理员"标记
- [ ] 建一个测试表单，拿到 `access_key`
- [ ] 真实提交一条数据到 `/s/<access_key>`，确认：
  - [ ] 后台提交记录里能看到
  - [ ] 如果配置了通知渠道，能收到通知
- [ ] 访问 `/admin`，确认普通用户访问会被重定向、管理员能看到概览数据
- [ ] 导出一次 CSV，确认内容正常
- [ ] 跟一下生产日志，确认没有异常报错：
  ```bash
  npx wrangler tail
  ```

---

### 首个管理员账号怎么来

不需要在 Supabase 控制台手动改 `role` 字段：

1. 把要当管理员的邮箱写进 `ADMIN_EMAILS` secret（逗号分隔可以填多个）
2. 用这个邮箱正常注册/登录一次
3. 登录成功的那一刻，代码会自动检查邮箱是否在 `ADMIN_EMAILS` 列表里，如果是且当前还不是 admin，就把 `profiles.role` 自动改成 `admin`
4. 之后这个账号登录就能看到"管理面板"入口

后续增减管理员，去 `/admin/users` 页面里改对应用户的角色，或者直接在 Supabase 控制台改 `profiles.role` 字段。

---

## 日常更新发布流程

```bash
npm run cf-typegen   # 改了 wrangler.json 绑定或新增了路由，要先跑这个
npm run check        # 类型检查 + build + dry-run，确认没问题
npm run deploy       # 正式发布
```

- 如果这次更新涉及新的数据库字段/表：先去 Supabase SQL Editor 把 DDL 跑了，**再**部署代码，避免代码上线后找不到新字段/表
- 如果这次更新涉及新的 secret：用 `wrangler secret put <NAME>` 更新，不需要重新部署代码，secret 更新对下一次请求立即生效

---

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 部署成功，打开页面直接报通用错误（"Oops! An unexpected error occurred."） | 生产环境没配 secrets（最常见！） | `npx wrangler secret list` 检查是否配了 `SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_KEY`/`ADMIN_EMAILS`，没有就按第 4.2 步补上；想看具体报错可以 `npx wrangler tail` 之后刷新页面 |
| `Could not find the table 'xxx' in the schema cache`（PGRST205） | PostgREST 没识别到刚建的表，可能是 SQL 实际没跑成功 | 去 Supabase Table Editor 肉眼确认表是否存在；不存在就重新跑 DDL，存在就等一会儿重试（schema cache 偶尔同步延迟） |
| 注册时报 `email rate limit exceeded` | Supabase 自带邮件发送频率限制，开发阶段连续注册测试账号容易触发 | 等一会儿重试，或者用下方脚本直接通过 Admin API 建一个已确认的测试账号，跳过发信环节 |
| 提交表单返回 404 `form not found or inactive` | `access_key` 错误，或表单被停用 | 确认 access_key 没抄错；表单状态变更会主动清缓存，正常不用等待 |
| 提交返回 429 | 触发了限流（单 IP 20次/分，单表单120次/分） | 正常防滥用行为，等 1 分钟再试 |
| 通知没收到 | 渠道配置错了，或者是不可重试的永久失败 | 去 `/admin/logs` 查有没有"通知渠道投递失败"记录；用渠道详情页的"测试"按钮单独测一下这个渠道 |
| 保存表单时报 `503 TURNSTILE_UNAVAILABLE` | 开启了 Turnstile 但没配 `TURNSTILE_SECRET` | 按第 2.6 步配置 Turnstile，或者先别开这个开关 |
| `wrangler deploy` 报绑定相关错误 | `wrangler.json` 里的 R2/KV/Queue 名字或 id 跟 Cloudflare 后台实际资源不一致 | `npx wrangler r2 bucket list` / `npx wrangler kv namespace list` / `npx wrangler queues list` 核对名字和 id |

跳过邮件确认、直接建一个已确认的测试账号（本地跑一次性脚本，不要把 service key 写进任何会提交的文件）：

```js
import { createClient } from "@supabase/supabase-js";
const admin = createClient("https://你的项目.supabase.co", "你的 SUPABASE_SERVICE_KEY");
await admin.auth.admin.createUser({
  email: "test@example.com",
  password: "Test12345678",
  email_confirm: true,
});
```
| 本地 `npm run dev` 起不来或读不到密钥 | `.dev.vars` 不存在或键名拼错 | 对照第 4.1 步检查文件内容，键名必须跟 `workers/env.d.ts` 里声明的一致 |

---

## 回滚

Cloudflare Workers 每次 `wrangler deploy` 都会生成一个新版本。出问题需要紧急回滚：

```bash
npx wrangler deployments list   # 看历史版本
npx wrangler rollback [版本ID]  # 回滚到指定版本（不传版本ID则回滚到上一个）
```

> 数据库层面没有自动回滚机制——如果某次更新包含了破坏性的 DDL（比如删字段），回滚代码并不会把数据库结构改回去，这种情况要手动写反向 SQL。**有破坏性的 DDL 变更，上线前一定要想清楚怎么退**，必要时先加字段、跑一段时间观察没问题后再删旧字段，而不是一步到位替换。

---

## 项目结构

```
app/
  routes.ts              # 路由表
  routes/
    home.tsx              # 首页
    login.tsx / register.tsx / logout.tsx
    dashboard/             # 用户后台（表单 CRUD、渠道管理、提交记录、用量）
    admin/                 # 管理员后台（用户/全局表单/概览/审计日志）
  lib/                     # SSR 用的 Supabase client、session 工具
workers/
  app.ts                   # Worker 入口：按路径分流到 Hono 或 React Router SSR
  api/
    public.ts              # 公开表单提交端点 /s/:accessKey
    forms.ts               # 用户 API /api/*
    admin.ts               # 管理员 API /api/admin/*
    notify-consumer.ts      # Queue 消费者，派发通知
  lib/                     # 鉴权、限流、套餐限额、通知渠道发送等共享逻辑
docs/
  FormStream-开发文档.md    # 完整架构设计、数据模型、API 设计
  前期准备清单.md            # 历史记录：账号/资源准备清单
```

更详细的架构设计、数据模型、API 设计、安全设计见 [`docs/FormStream-开发文档.md`](docs/FormStream-开发文档.md)。

## 本地开发常用命令

```bash
npm run dev          # 本地开发（HMR）
npm run cf-typegen   # 重新生成 Cloudflare 绑定类型 + 路由类型
npm run check        # 类型检查 + build + dry-run 部署
npm run build        # 生产构建
npm run deploy       # 构建并发布到 Cloudflare
npx wrangler tail    # 实时查看生产日志
```

---

*本 README 即本项目的完整部署文档。如果实际操作中发现某一步和现状不符（比如 Cloudflare/Supabase 控制台改版），以官方最新文档为准，并欢迎更新本文件。*
