# CI 原始产物清单（供离线复核）

## 文件
docs/ci-evidence/ci-job-114416237110.log
  bytes  = 199721
  sha256 = bd966c4310ba908ffa1035a06f677e1ec7e7aec14a73f1714c189a2b2ffba842
  来源   = GET https://api.github.com/repos/qawse110/dsh-launcher-android/actions/jobs/114416237110/logs
           （run 38121241090 / head_sha 0c583048 / job conclusion=success）
  说明   = 未经改写的原始 job 日志；下面给出行内字节偏移，可自行 grep 核对。

## 关键行（含字节偏移；日志前缀为 ISO 时间戳，已去 ANSI 颜色码）
offset=194087: TESTCLASS com.dsh.nextapp1.ui.UiFlowRowLayoutTest tests=7 failures=0 errors=0
offset=194194: TESTCLASS com.dsh.nextapp1.ui.UiFlowRowTest       tests=5 failures=0 errors=0
TESTTOTAL tests=111 failures+errors=0

## 核对命令（任选）
  grep -a 'UiFlowRowLayoutTest' docs/ci-evidence/ci-job-114416237110.log
  sha256sum docs/ci-evidence/ci-job-114416237110.log

## 这批数字与仓库源码的对应
  UiFlowRowLayoutTest.kt 中 `@Test` 出现 7 次  <-> 日志 tests=7
  UiFlowRowTest.kt       中 `@Test` 出现 5 次  <-> 日志 tests=5
  11 个测试类的 tests 之和 = 111             <-> 日志 TESTTOTAL tests=111
