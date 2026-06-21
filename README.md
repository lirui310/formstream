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

## 部署方式说明（一定要先看这一节）

在动手之前，先搞清楚一件最关键的事：**这个项目"上线"是怎么发生的？**

### 不是 Git 自动部署，是你自己在电脑上手动推送

很多平台（比如 Vercel、Netlify，或者 Cloudflare Pages 的某些配置）支持"把代码 push 到 GitHub，平台自动检测到变化并帮你部署"。

**这个项目不是这种模式。** 它用的是 Cloudflare 官方的命令行工具 **Wrangler**，部署这个动作是你在自己电脑的终端里手动敲一条命令（`npm run deploy`）触发的，Cloudflare 不会去监听你的 GitHub 仓库。

把这两件事分清楚：

```
你的电脑（写代码、改配置文件）
   │
   ├── git push origin main ──────────────► GitHub
   │   （只是把代码备份到 GitHub，仅此而已。
   │    网站不会因为这个动作有任何变化。）
   │
   └── npm run deploy ────────────────────► Cloudflare
       （这条命令会在你电脑上把项目构建好，
        然后直接上传到 Cloudflare 并让它生效。
        这才是真正让网站"上线"/"更新"的动作。）
```

也就是说：

- `git push` 推到 GitHub，**网站不会变**，那只是代码版本记录/备份
- 只有在你自己电脑的终端里运行 `npm run deploy`（本质就是调用 `wrangler deploy`），**这一刻网站才会真正更新**
- 这两件事互不依赖，谁先谁后都行，但缺了 `npm run deploy` 这一步，你改的代码永远不会出现在线上

### "在终端执行"具体是什么意思

下面所有写着要"运行"的命令，都是指：

1. 打开你电脑上的终端程序（macOS 叫"终端"/Terminal，Windows 可以用 PowerShell 或者 VS Code 里自带的终端）
2. 用 `cd` 命令进到这个项目的文件夹里（比如 `cd ~/Desktop/formstream`）
3. 把命令完整复制粘贴进去，按回车执行

不是去 Cloudflare 或 Supabase 的网页上找按钮点。本文档后面每一步都会标注清楚是要**在终端敲命令**，还是要**去网页控制台点几下**，两种操作不要搞混。

### 整体流程长什么样

```
① Supabase 网页控制台          ② Cloudflare 网页控制台/终端命令
   建数据库表、开权限策略           建 R2 存储桶 / KV / Queue 资源
   拿到 3 个连接用的 key                  │
        │                              │
        └──────────────┬───────────────┘
                        ▼
         ③ 在你电脑的项目代码里
         把上面拿到的东西填进配置文件、
         配置成"密钥"（secrets）
                        │
                        ▼
         ④ 本地终端运行 npm run dev
         自己先测一遍，确认能正常注册/登录/收表单
                        │
                        ▼
         ⑤ 本地终端运行 npm run deploy
         这一步才是真正把网站发布到 Cloudflare
                        │
                        ▼
              网站正式可以被任何人访问
```

记住这张图，再往下看每一步就不会迷路了。

---

## 部署指南

下面假设你是**第一次部署这个项目**：刚 Fork/Clone 了仓库，Cloudflare、Supabase 账号都还没配置任何东西。每一步开头都标了 **在哪里操作**，跟着做就行。

### 你需要准备

- 一台能上网的电脑，装好 **Node.js**（建议 20 版本以上）—— 装好之后在终端运行 `node -v` 能看到版本号就算装好了
- 一个 **Cloudflare** 账号，已绑定支付方式（R2/KV 这两个存储功能首次启用通常要求账号绑过卡，即使实际用量在免费额度内也要绑）
- 一个 **Supabase** 账号
- （可选）一个域名、一个 Resend 账号——没有也能先把整个流程跑通，只是邮件通知/自定义域名暂时用不上

### 第 0 步：把代码拉到你电脑上

📍 **在哪里操作：本地终端**

```bash
git clone <你 fork 的仓库地址>
cd formstream
npm install
```

`git clone` 把代码下载到你电脑上；`cd formstream` 进入这个文件夹；`npm install` 把项目需要的依赖包都装好。装完之后，**接下来所有命令都假设你的终端当前停留在这个 `formstream` 文件夹里**。

---

### 第 1 步：去 Supabase 把数据库建起来

📍 **在哪里操作：Supabase 网页控制台**（[supabase.com](https://supabase.com)，浏览器里操作，不涉及终端命令，除了 1.2 节里跑 SQL 也是在网页里的"SQL Editor"里粘贴执行，不是本地终端）

#### 1.1 建项目

1. 打开 [supabase.com](https://supabase.com) → 登录 → New Project
2. 项目名随意，比如 `formstream`
3. 数据库密码：随机生成一个强密码，存进密码管理工具——**这个项目本身用不到这个密码**（连库走的是 `supabase-js`/REST API，不走裸 Postgres 连接），只有你要直连数据库做运维时才用得上，正常部署流程不需要它
4. Region：选离你目标用户最近的区域，建好之后不好迁移，提前想清楚
5. Plan：开发阶段用 Free 没问题；**正式上线前必须升级到 Pro**——Free 档闲置 7 天会自动暂停项目，不适合生产环境

#### 1.2 初始化数据库

项目建好后，左侧菜单找到 **SQL Editor**，依次粘贴执行下面三段 SQL（每段粘贴进编辑器，点 Run）。

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

这一步是在限制"谁能看到谁的数据"，必须做，不然所有用户的数据互相都能看到：

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

> ⚠️ **跑完务必去左侧菜单的 Table Editor 里肉眼确认这 6 张表真的出现了。** Supabase 偶尔会出现"SQL 跑完没报错，但接口那边一时还查不到表"的情况（错误码 `PGRST205`，提示 `Could not find the table 'xxx' in the schema cache`）。如果遇到，先去 Table Editor 确认表是否存在，存在的话等一会儿重试就好。

**③ 确认触发器生效（可选，自己检查一下）**

```sql
select tgname from pg_trigger where tgname = 'on_auth_user_created';
```
能查到一行结果，说明触发器建好了——之后每个新注册用户都会自动在 `profiles` 表里生成一条记录，不用手动处理。

#### 1.3 打开邮箱登录方式

1. 左侧菜单 Authentication → Providers：确认 **Email** 是开启状态（新项目默认就是开的，看一眼确认即可）
2. Authentication → URL Configuration：
   - Site URL 先填 `http://localhost:5173`（本地测试用的地址），等你部署上线、拿到正式网址后再回来改成正式地址
   - Redirect URLs 跟 Site URL 填一样的就行，这个项目没用到第三方登录跳转
3. 邮件模板用 Supabase 自带的默认模板就够了（注册确认邮件、找回密码邮件），不需要单独配邮件服务器
4. 提个醒：Supabase 自带的发信功能有频率限制（免费档大概每小时几封），如果你在测试阶段连续注册了好几个账号，可能会报 `email rate limit exceeded`——这是正常现象，等一会儿再试，或者看本文档最后[故障排查](#故障排查)里那段跳过邮件确认直接建账号的方法

#### 1.4 拿到 3 个关键信息，记在某个地方备用

左侧菜单 Settings → API，这一页里找：

| 名称 | 在页面里长什么样 | 接下来要用在哪 |
|---|---|---|
| Project URL | 形如 `https://abcdefgh.supabase.co` | 第 3 步要填进配置文件 |
| Publishable key（早期版本叫 anon key） | 形如 `sb_publishable_xxxxx` | 第 4 步要配成密钥 `SUPABASE_ANON_KEY` |
| Secret key（早期版本叫 service_role key） | 形如 `sb_secret_xxxxx` | 第 4 步要配成密钥 `SUPABASE_SERVICE_KEY`，**这个最高权限，不能泄露、不能截图发别人** |

> 备注：Supabase 后台把 key 的名字改过——以前叫 `anon key`/`service_role key`，现在叫 `Publishable key`/`Secret keys`。本质是同一个东西，名字换了而已，新版还支持给一个项目建多个 Secret key（方便以后单独吊销），用默认给的那一个就行。

把这 3 个值先复制粘贴存到一个临时的笔记里（比如备忘录），第 3、4 步马上要用。

---

### 第 2 步：去 Cloudflare 把云资源建起来

📍 **在哪里操作：本地终端 + Cloudflare 网页控制台**（这一步两种都有，每个小节会分别注明）

#### 2.1 确认账号已经绑定支付方式

📍 浏览器：登录 [dash.cloudflare.com](https://dash.cloudflare.com)，左侧 Billing 里看一下是否已绑卡。R2/KV 这两项即使用量在免费额度内，首次启用通常也会要求账号已绑定支付方式。

Cloudflare Queues（队列功能）现在 **免费计划就能直接用**，不需要为了这个项目升级付费计划：免费档每天 10,000 次操作、消息保留 24 小时；付费计划（$5/月起）每月 100 万次操作、保留期可以配到 14 天。先用免费的就够。

#### 2.2 让本地的命令行工具登录你的 Cloudflare 账号

📍 **本地终端**：

```bash
npx wrangler login
```

执行后会自动打开浏览器，跳到 Cloudflare 的授权页面，点"允许"。授权完终端会显示成功，以后这台电脑上就不用重复登录了。

> `wrangler` 是 Cloudflare 官方的命令行工具，专门用来创建资源、部署代码。`npx wrangler xxx` 的意思是"运行项目里已经装好的 wrangler 工具，执行 xxx 这个操作"，不需要你额外单独安装它。

#### 2.3 创建文件存储空间（R2）

📍 **本地终端**：

```bash
npx wrangler r2 bucket create formstream-uploads
```

这条命令会在 Cloudflare 上创建一个叫 `formstream-uploads` 的存储桶，用来存表单提交时上传的附件文件。名字可以自己改，但如果改了要记得第 3 步配置文件里也要写一样的名字。

#### 2.4 创建限流缓存空间（KV）

📍 **本地终端**：

```bash
npx wrangler kv namespace create RATE_LIMIT
```

执行后终端会打印出一个 `id`（一长串字符），**把这个 id 复制记下来**，第 3 步要填进配置文件。

#### 2.5 创建消息队列（Queue）

📍 **本地终端**：

```bash
npx wrangler queues create formstream-notify
```

这个队列用来异步处理通知发送（钉钉/飞书/邮件等），避免表单提交时卡住等通知发完才返回。

#### 2.6 （可选）开启 Turnstile 人机验证

📍 **浏览器**：Cloudflare 控制台左侧菜单找 Turnstile → Add site

1. Domain 填你的正式域名（暂时没域名可以先随便填个占位的，等真的有域名了再回来改）
2. 创建完会拿到两个值：**Site Key**（前端页面要嵌入用的，不是机密）和 **Secret Key**（后端校验用的，第 4 步要配成密钥 `TURNSTILE_SECRET`）

这一步现在跳过完全不影响其他功能正常使用。只有一点要注意：如果你之后在后台某个表单上把"开启 Turnstile"打开了，但又没配 `TURNSTILE_SECRET`，系统会直接拒绝保存并报错（`503 TURNSTILE_UNAVAILABLE`），而不是"开了但实际不生效"——这是故意设计成这样，避免你以为开了人机验证但其实没生效。

#### 2.7 （可选）绑定自定义域名

📍 **浏览器**：

1. 先把你的域名加到 Cloudflare 账号里（去域名注册商那边把 NS 服务器改成 Cloudflare 给的）
2. 等第 6 步部署完 Worker 之后，回到 Cloudflare 控制台 → Workers & Pages → 找到 `formstream` 这个 Worker → Settings → Domains & Routes → 绑定你的域名
3. 没有域名完全不影响部署，Cloudflare 会自动给你分配一个 `xxx.workers.dev` 的免费子域名，先用这个

#### 2.8 （可选）注册 Resend 用来发邮件通知

📍 **浏览器**：

1. 注册 [resend.com](https://resend.com)
2. 如果有自己的域名：Domains → 添加发信域名，按提示在 DNS 里加几条记录（域名如果也托管在 Cloudflare，直接在 Cloudflare 的 DNS 设置里加）
3. 拿到 `RESEND_API_KEY`，第 4 步要用
4. 没有自己验证的域名也不影响，先用 Resend 提供的默认测试发件地址跑通流程，正式对外用之前再换成自己的域名

---

### 第 3 步：把刚才拿到的资源信息填进项目配置

📍 **在哪里操作：本地代码编辑器**（用任何文本编辑器打开项目文件夹，不是网页操作）

打开项目根目录下的 `wrangler.json` 文件，把第 1、2 步里拿到的信息填进去：

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

具体对应关系：

- `vars.SUPABASE_URL` ← 第 1.4 步拿到的 Project URL
- `r2_buckets[0].bucket_name` ← 第 2.3 步创建的 bucket 名字（如果没改名就是 `formstream-uploads`，跟示例一样不用改）
- `kv_namespaces[0].id` ← 第 2.4 步终端打印出来的那个 id（这个必须改，每个人的都不一样）
- `queues` 部分如果第 2.5 步没改队列名字，也不用改

改完保存文件后，回到终端，运行：

📍 **本地终端**：

```bash
npm run cf-typegen
```

这条命令会根据你刚改的配置重新生成一些 TypeScript 类型定义文件，让代码能正确识别这些资源。**以后每次改了 `wrangler.json` 里的资源配置，都要重新跑一下这条命令。**

---

### 第 4 步：配置密钥（Secrets）

📍 **在哪里操作：先本地代码编辑器，再本地终端**

这一步是整个流程里最容易出问题、也最容易被忽略的一步——**密钥要配置两遍，一遍给本地开发用，一遍给线上部署用，两边互不相通**。

项目一共要用到这 5 个密钥：

| 名称 | 是什么 | 必填吗 |
|---|---|---|
| `SUPABASE_ANON_KEY` | 第 1.4 步的 Publishable key | ✅ 必填 |
| `SUPABASE_SERVICE_KEY` | 第 1.4 步的 Secret key | ✅ 必填 |
| `ADMIN_EMAILS` | 你想用来当管理员的邮箱（逗号分隔，可以填多个） | ✅ 必填 |
| `RESEND_API_KEY` | 第 2.8 步的 Resend key | 可选，没配就是不发邮件通知 |
| `TURNSTILE_SECRET` | 第 2.6 步的 Turnstile Secret Key | 可选，没配就是不强制人机验证 |

#### 4.1 本地开发用：新建一个 `.dev.vars` 文件

📍 **本地代码编辑器**：在项目根目录（跟 `wrangler.json` 同一层）新建一个文件，文件名就是 `.dev.vars`，内容填：

```
SUPABASE_ANON_KEY=sb_publishable_你的真实值
SUPABASE_SERVICE_KEY=sb_secret_你的真实值
ADMIN_EMAILS=你的邮箱@example.com
RESEND_API_KEY=re_你的真实值
```

这个文件已经被 `.gitignore` 排除了，不会被 git 提交、不会被 push 到 GitHub 上，放心写真实值。`TURNSTILE_SECRET` 如果没配 Turnstile 就不用写这一行。

这个文件**只有在你本地运行 `npm run dev` 的时候才会被读取**，跟线上部署完全无关——这就是为什么下面还要再配一遍。

#### 4.2 线上部署用：在终端里逐条配置

📍 **本地终端**：

> ⚠️ **这一步是上一次很多人卡住的地方**：如果漏了这一步，代码部署是会"成功"的（终端不会报错），但打开网站会直接看到一个通用错误页面（"Oops! An unexpected error occurred."），因为程序在云端找不到 Supabase 的密钥，连不上数据库。`.dev.vars` 文件**只对本地 `npm run dev` 有效，对线上部署完全没有作用**，必须用下面的命令单独配置一遍。

依次运行（一条一条来，不要一次性全部粘贴）：

```bash
npx wrangler secret put SUPABASE_ANON_KEY
```
运行后终端会停下来等你输入，把第 1.4 步的 Publishable key 粘贴进去，按回车。

```bash
npx wrangler secret put SUPABASE_SERVICE_KEY
```
同样的方式，粘贴 Secret key。

```bash
npx wrangler secret put ADMIN_EMAILS
```
粘贴你想当管理员的邮箱。

```bash
npx wrangler secret put RESEND_API_KEY
```
可选，没有 Resend key 可以跳过这条不执行。

```bash
npx wrangler secret put TURNSTILE_SECRET
```
可选，没配 Turnstile 可以跳过这条不执行。

> 输入的内容在终端里不会显示出来（这是正常的安全设计），也不会留在终端历史记录里，正常粘贴+回车就行，不用担心"是不是输错了看不到"。

全部配完后，检查一下配置了哪些（只能看到名字，看不到具体的值）：

```bash
npx wrangler secret list
```

至少要看到 `SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_KEY`、`ADMIN_EMAILS` 这三个，否则网站上线后一定会报错。

---

### 第 5 步：本地先跑起来，自己测一遍

📍 **本地终端**：

```bash
npm run dev
```

终端会显示一个本地网址，一般是 `http://localhost:5173`，用浏览器打开它。这一步是在你自己电脑上跑一个临时的测试版本，**还没有发布到网上**，只有你自己能访问。

打开后，照着这个顺序测一遍：

1. 首页能正常打开，能看到"登录"/"注册"按钮（如果这一步就报错，回去检查第 4.1 步 `.dev.vars` 文件内容是否正确）
2. 用第 4 步 `ADMIN_EMAILS` 里填的邮箱注册一个账号——注册后大概率要去这个邮箱里点一下确认链接才能正式登录，这是 Supabase 默认的安全机制
3. 登录后，看页面右上角是不是显示了"管理员"字样——显示了说明自动提权的逻辑生效了
4. 在后台新建一个表单，会拿到一个 `access_key`（一串字符）
5. 打开一个新的终端窗口（保持 `npm run dev` 那个窗口继续运行），用下面的命令模拟一次表单提交（把 `<access_key>` 换成你刚拿到的那个）：
   ```bash
   curl -X POST http://localhost:5173/s/<access_key> -d "name=test" -H "Accept: application/json"
   ```
6. 回到后台页面刷新一下，确认刚才这条提交记录出现了

跑 `npm run dev` 的那个终端窗口里，如果你看到类似 `QUEUE formstream-notify 1/1 (...)` 的输出，说明通知队列在本地也跑通了。

这一步全部测通过之后，才进入下一步真正发布上线。

---

### 第 6 步：正式发布上线

📍 **本地终端**：这是真正让网站对外可访问的一步。

#### 6.1 先做一次完整检查（推荐，不是必须）

```bash
npm run check
```

这条命令会依次做三件事：检查代码有没有明显错误 → 把项目构建一遍 → 模拟一次部署（不会真的发布，只是验证配置对不对）。三步都没报错，再进行下一步会更踏实。

#### 6.2 真正发布

```bash
npm run deploy
```

**这一条命令，才是真正把代码发布到 Cloudflare、让网站对外可以访问的动作。** 它会先把项目构建一遍，然后把构建结果上传到 Cloudflare。执行完成后，终端会打印出网站的访问地址，类似这样：

```
Uploaded formstream (x.xx sec)
Deployed formstream triggers (x.xx sec)
  https://formstream.<你的账号>.workers.dev
```

复制这个网址在浏览器打开，就是线上正式版本了。

> 之后每次你改了代码想更新线上版本，重复运行这条 `npm run deploy` 就行——不需要重新做第 1～4 步（那些是一次性的账号/资源/密钥配置）。

---

### 第 7 步：上线后自己验证一遍

部署完别急着收工，照着这个清单点一遍，确认每个功能都正常：

- [ ] 打开部署后拿到的网址，首页能正常打开（不是报错页）
- [ ] `/login`、`/register` 页面能正常打开
- [ ] 用管理员邮箱注册/登录，后台显示"管理员"标记
- [ ] 建一个测试表单，拿到 `access_key`
- [ ] 真实提交一条数据到 `https://你的网址/s/<access_key>`，确认：
  - [ ] 后台提交记录里能看到这条数据
  - [ ] 如果配置了通知渠道，能收到通知
- [ ] 访问 `/admin`，确认普通用户访问会被自动跳走、管理员账号能看到管理面板
- [ ] 导出一次 CSV，确认下载的文件内容正常
- [ ] 在终端运行下面这条命令，实时看线上日志，确认没有报错：
  ```bash
  npx wrangler tail
  ```

---

### 第一个管理员账号是怎么来的

不需要去 Supabase 控制台手动改数据库字段，流程是自动的：

1. 把你想当管理员的邮箱写进第 4 步的 `ADMIN_EMAILS` 密钥里（逗号分隔可以填多个邮箱）
2. 用这个邮箱在网站上正常注册、登录一次
3. 登录成功的那一刻，代码会自动检查："这个邮箱是不是在 `ADMIN_EMAILS` 列表里？如果是，且现在还不是管理员，就自动把它设置成管理员"
4. 之后这个账号登录，就能在后台看到"管理面板"入口了

以后要增加/取消别人的管理员权限，登录管理员账号后去 `/admin/users` 页面里直接改对方的角色就行，不需要再走一遍上面的流程。

---

## 日常更新发布流程

代码改完之后，正常发布一次更新，按顺序运行：

```bash
npm run cf-typegen   # 如果这次改了 wrangler.json 里的资源配置或新增了页面路由，先跑这个
npm run check        # 检查一遍没问题
npm run deploy       # 正式发布，这一步才会真正更新线上网站
```

- 如果这次更新涉及新的数据库字段/表：**先**去 Supabase SQL Editor 把对应的 SQL 跑了，**再**执行 `npm run deploy`，顺序不能反，否则代码上线后会因为找不到新字段/表而报错
- 如果这次更新涉及新增/修改密钥：用 `npx wrangler secret put <名称>` 单独更新，不需要重新执行 `npm run deploy`，密钥更新后下一次访问立即生效

---

## 故障排查

| 现象 | 原因 | 怎么处理 |
|---|---|---|
| 部署"成功"，但打开网站直接看到一个通用错误页（"Oops! An unexpected error occurred."） | 线上环境没配密钥（最常见的问题，几乎所有第一次部署的人都会遇到） | 运行 `npx wrangler secret list` 检查是否配了 `SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_KEY`/`ADMIN_EMAILS`，没有就回到第 4.2 步补上；想看具体的报错内容，可以先运行 `npx wrangler tail`，让它保持运行，然后用浏览器重新打开一次网站，错误信息会实时打印在终端里 |
| 报错信息里有 `Could not find the table 'xxx' in the schema cache`（错误码 `PGRST205`） | Supabase 那边一时还没识别到刚建的表 | 去 Supabase 的 Table Editor 里肉眼确认表是否真的存在；存在的话等一会儿重试，不存在就回到第 1.2 步重新跑一遍 SQL |
| 注册账号时报 `email rate limit exceeded` | Supabase 自带的发信功能有频率限制，测试阶段连续注册多个账号容易触发 | 等一会儿重试，或者用下方脚本直接跳过邮件确认环节 |
| 提交表单返回 404，提示 `form not found or inactive` | `access_key` 抄错了，或者这个表单被停用了 | 检查 access_key 有没有抄错；表单状态变化是即时生效的，不需要等待 |
| 提交表单返回 429 | 触发了防滥用限流（同一 IP 每分钟最多 20 次，同一表单每分钟最多 120 次） | 这是正常的防护机制，等 1 分钟再试 |
| 配置了通知渠道但是没收到通知 | 渠道配置错了（比如 webhook 地址填错），或者是遇到了不会重试的永久性错误 | 去后台 `/admin/logs` 页面看看有没有"通知渠道投递失败"的记录；也可以在渠道详情页点"测试"按钮单独测一下这个渠道是否配置正确 |
| 保存表单设置时报错 `503 TURNSTILE_UNAVAILABLE` | 在后台把"开启 Turnstile"打开了，但是没有配置 `TURNSTILE_SECRET` 密钥 | 回到第 2.6 步配置好 Turnstile，或者先不要打开这个开关 |
| 运行 `npm run deploy` 时报跟资源绑定相关的错误 | `wrangler.json` 里填的 R2/KV/Queue 的名字或 id，跟 Cloudflare 那边实际创建的资源不一致（比如复制 id 时漏了字符） | 运行 `npx wrangler r2 bucket list`、`npx wrangler kv namespace list`、`npx wrangler queues list` 分别查一下实际的名字和 id，跟 `wrangler.json` 里的逐字核对 |
| 本地运行 `npm run dev` 起不来，或者页面提示读不到密钥 | `.dev.vars` 文件不存在，或者文件里的变量名拼错了 | 对照第 4.1 步检查这个文件是否存在、内容是否正确，变量名必须跟代码里 `workers/env.d.ts` 文件里写的完全一致（大小写也要一致） |

**跳过邮件确认、直接创建一个已确认状态的测试账号**（在本地新建一个临时的 `.mjs` 文件，用 Node.js 运行，运行完可以删掉这个文件——注意这段代码里的 service key 只能在自己电脑上临时用，不要把它写进任何会被提交到 git 的文件里）：

```js
import { createClient } from "@supabase/supabase-js";
const admin = createClient("https://你的项目id.supabase.co", "你的 SUPABASE_SERVICE_KEY");
await admin.auth.admin.createUser({
  email: "test@example.com",
  password: "Test12345678",
  email_confirm: true,
});
```

运行方式（在项目目录下，把代码存成比如 `create-test-user.mjs`）：
```bash
node create-test-user.mjs
```

---

## 回滚

Cloudflare Workers 每次运行 `npm run deploy` 都会生成一个新的版本记录。如果发布之后发现问题，需要紧急回滚到上一个版本：

📍 **本地终端**：

```bash
npx wrangler deployments list   # 看看历史上有哪些版本，每个版本前面有一串 ID
npx wrangler rollback           # 不带参数，回滚到上一个版本
npx wrangler rollback <版本ID>  # 或者指定回滚到某个具体版本
```

> ⚠️ 这个回滚只针对代码本身，**数据库结构不会跟着自动回滚**。如果某次更新里包含了"删字段""删表"这种破坏性的数据库改动，回滚代码并不会把数据库结构改回去，要手动写反向的 SQL 才能恢复。所以涉及破坏性数据库改动的更新，上线前一定要想清楚怎么应对最坏情况，比较稳妥的做法是先加新字段、观察一段时间没问题后再删旧字段，而不是一步到位地替换。

---

## 项目结构

```
app/
  routes.ts              # 路由表，定义每个网址对应哪个页面文件
  routes/
    home.tsx              # 首页
    login.tsx / register.tsx / logout.tsx
    dashboard/             # 用户后台（表单 CRUD、渠道管理、提交记录、用量）
    admin/                 # 管理员后台（用户/全局表单/概览/审计日志）
  lib/                     # 服务端渲染时用到的 Supabase 客户端、登录态工具
workers/
  app.ts                   # 程序入口：根据网址路径决定交给 API 处理还是渲染页面
  api/
    public.ts              # 公开的表单提交接口 /s/:accessKey
    forms.ts               # 登录用户用的接口 /api/*
    admin.ts               # 管理员专用接口 /api/admin/*
    notify-consumer.ts      # 处理通知发送的后台任务
  lib/                     # 鉴权、限流、套餐限额、通知渠道发送等共用逻辑
docs/
  FormStream-开发文档.md    # 完整架构设计、数据模型、API 设计
  前期准备清单.md            # 历史记录：账号/资源准备清单
```

更详细的架构设计、数据模型、API 设计、安全设计见 [`docs/FormStream-开发文档.md`](docs/FormStream-开发文档.md)。

## 本地开发常用命令速查

| 命令 | 作用 |
|---|---|
| `npm run dev` | 本地启动测试版本，改代码会自动刷新 |
| `npm run cf-typegen` | 改了 `wrangler.json` 资源配置或新增页面路由后，重新生成类型 |
| `npm run check` | 检查代码 + 构建一遍 + 模拟部署一遍，不会真的发布 |
| `npm run build` | 正式构建（一般不需要单独运行，`deploy` 会自动包含这一步） |
| `npm run deploy` | **真正发布到 Cloudflare，让线上网站更新** |
| `npx wrangler tail` | 实时查看线上日志，排查问题时用 |
| `npx wrangler secret list` | 看线上配置了哪些密钥（只显示名字） |
| `npx wrangler deployments list` | 看历史部署版本 |

---

*本 README 就是本项目的完整部署文档。如果实际操作中发现某一步和现状不符（比如 Cloudflare/Supabase 控制台改版），以官方最新文档为准，并欢迎更新本文件。*
