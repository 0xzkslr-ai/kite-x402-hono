# Week 4: non-blocking stream cleanup

Continue the Kite x402 Bun/Hono wrapper in the same repository.

## Problem

Version 0.3.0 awaited stream cancellation when rejecting oversized bodies and
upstream redirects. An asynchronous producer cleanup that never resolves could
hold the entire request and concurrency slot indefinitely. A rejecting cleanup
could also replace the intended error. Already-aborted reads released the reader
lock but did not cancel the source.

## Change and evidence

Initiate cancellation without awaiting producer cleanup, handle cleanup rejection,
cancel unfinished reads once, and always release the reader lock. Successful
reads keep their exact bytes and do not cancel completed streams.

Nine regression tests cover pending and rejecting cancellation for oversized
requests, oversized responses and redirects; they verify original HTTP errors,
no settlement or payment receipt, health availability and capacity recovery using
an unpaid challenge. Additional cases cover already-aborted reads, abort during a
pending read, and successful multi-chunk reads at the exact size limit.

Against the previous source, seven of these nine tests fail. With the fix all nine
pass. Test payment verification is simulated; no real on-chain payment is claimed.
The stream cleanup fix was published in version 0.3.1. Community PR features
described in the root changelog are included in version 0.3.2.

Cancellation is best-effort, not proof the producer released external resources.
An injected stream must manage its own resources. This change neither aborts an
in-flight settlement nor retries payment or undoes an upstream action.

## 可提交说明

第四周修复数据流清理阻塞请求的问题：超大请求/响应和上游重定向被拒绝时，
发起取消但不等待生产者清理，防止清理挂起占住并发名额；清理异常不再覆盖原始错误。
补齐已取消请求的流清理，确保读取器释放锁。新增 9 项回归测试，覆盖挂起/失败清理、
原始错误保留、不结算、不返回付款收据、健康检查、并发恢复以及正常响应字节完整性。
