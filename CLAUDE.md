# 给 Claude 的规则

## Git 与 PR（必须遵守）

每次 `git push` 之前，先确认这个分支的 PR 状态，不能凭记忆：

```bash
git fetch origin main
git log --oneline -3 origin/main
```

- 分支的 PR 已经合并（main 里能看到那个 PR 的提交）：**不要再往这个旧分支上叠提交**。
  从最新的 `origin/main` 重建分支（`git checkout -B <分支> origin/main`），把还没合并的提交 cherry-pick 过来，
  `git push --force-with-lease`，然后**开新 PR**。
- 推送后回复里写清楚：改动在哪个 PR、这个 PR 是新开的还是已有的、是否已合并。
- 修复类提交推送前也一样要检查——上一个 PR 可能已经合并，修复会被漏掉。
