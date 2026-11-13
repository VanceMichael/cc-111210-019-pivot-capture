# 分层透视页面的明细采集

本项目用于授权资料接入的单次查看与接收留存，使用 Node.js 22。来源协议见 `docs/source-contract.md`。本地演练服务只绑定回环地址，数据不含真实个人资料或账号。

## 安装与运行

依赖由 `package-lock.json` 固定。首次准备环境运行 `npm ci --ignore-scripts`，浏览器项目使用 Playwright 1.56.1 对应的 Chromium；浏览器及系统库在镜像准备阶段安装，不在业务命令中下载。

```sh
npm run build
npm test
npm run demo
npm start
```

`npm run demo` 启动本地来源和接入服务，实际获取单次查看结果并写入临时接收记录，显示完整 JSON，随后关闭服务并清理临时目录。通常在十秒内结束。`npm start` 启动常驻服务，默认端口3000，可通过 PORT 与 DATA_DIR 修改监听端口和接收目录。设置 SOURCE_URL 可连接另一进程中已启动的本地来源；不设置时自动创建演练来源。恢复演练可先用 `npm run source` 在另一终端启动来源，记下输出地址，保持该进程运行，仅重启设置了 SOURCE_URL 的接入服务。

## 接口与模块

`GET /health` 查看状态，`GET /inspect` 查看来源原始可见行，`GET /receive?key=sample` 保存单次接收，`GET /receipts/sample` 读取回执。相同key和相同内容可重复接收，不同内容拒绝覆盖。

`GET /collect?grain=museum,zone,date` 执行按粒度的叶项采集：只返回叶项，附维度路径、屏幕来源、版次/筛选/维度快照、Top-N 覆盖边界、抑制/缺测/真实零值分类与小计核对差额；`GET /collect/receive?key=finance` 同时留存回执。目标粒度不是页面叶粒度时返回明确错误。采集中若页面版次或维度变化，本轮作废并保留失败证据后自动重启一致的一轮。

`src/connector.mjs` 解释单次来源响应，`src/collector.mjs` 实现叶项采集流程（版次守卫、行身份归一、状态分类、覆盖边界），`fixtures/source.mjs` 提供可重复启动的本地来源，`src/service.mjs` 组织访问入口，`src/store.mjs` 保存查看结果。`test/connector.test.mjs` 验证协议原语和演练源，`test/collector.test.mjs` 验证采集流程的中断重启、维度重排与覆盖边界，`test/service.test.mjs` 验证服务与留存边界。

生产接入地址与凭据需由部署配置给出；演练客户端拒绝访问回环以外的地址。文档中的接口不向外提供任意目标代理。异常以明确错误响应返回，接收失败不覆盖原回执。
