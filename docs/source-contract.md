# 分层透视页面
页面同时显示总计、馆级小计和展开后的叶项。展开模拟延迟加载，数据区声明筛选、维度顺序与generation；刷新和重排维度会清空展开并递增版次。value、suppressed和missing是不同单元格状态。
Top-N提示故意声明仍有不可展开项，页面没有提供这些项的明细。现有查看器只读取可见行，不声称完成明细采集。总计与小计仅用于页面核对，不可作为被抑制项目的推算依据。 门户的业务数据保存在本地来源服务中，关闭或重新打开浏览器不会撤销已接受的写入；页面data-saved可用于等待门户自身保存结束。状态接口只供门户运行，自动化不得直接调用它代替界面操作。

## 叶项采集流程（`src/collector.mjs`）

采集器只产出页面真正的叶粒度（museum/zone/date），行身份按规范维度顺序归一，与屏幕上的维度排列解耦：

1. 开局先快照数据区的 `data-query`（当前筛选）、`data-dimensions`（维度顺序）与 `data-generation`（数据版次），并在每个展开检查点复核；任一变化即中止本轮，证据（阶段、期望/观测版次、当时可见行）写入 `abortedRounds`，重新加载页面后启动一致的新一轮，最多三轮。
2. 沿展开路径定位行：根节点用只依赖首层维度 grain 的稳定选择器，不依赖相邻行位置；懒加载占位（禁用的“加载中”按钮）记录在 `lazyLoads`，绝不计入业务行。
3. 叶项按 `data-state` 分类：`value`（含真实零值，`isZero:true`）、`suppressed`（抑制展示）、`missing`（空值/缺测），三类互不混淆；解析不出数字的值标为 `unparseable` 而非零。
4. Top-N 覆盖边界从 `data-coverage` 读取，剩余项数写入 `coverage.remainingItems` 与 `completeness.gaps`；剩余项没有展开入口，报告只声明边界，绝不把总计/小计差额分摊成剩余明细。
5. 总计与小计只进入 `controls` 与 `reconciliation`：`leafNumericSum` 是可采叶项的数值和，`difference` 是与页面对照值的差，差额只能由 Top-N 剩余、抑制与缺测解释。
6. 每个叶项带 `canonicalPath`/`pathByDimension`（维度路径）与 `screenSource`（屏幕行 key、grain、版次、原文、展开来源）。
7. 目标粒度与页面叶粒度不一致时直接拒绝（`grain-mismatch`），不用小计冒充粗粒度明细。
