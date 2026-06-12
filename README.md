# NaniAnime
**"不知道该看什么番？让 NaniAnime 为你决定。"**

NaniAnime 是一个基于 Bangumi API 的随机动漫推荐工具。告别选择困难症。

---

![image](https://github.com/uerax/NaniAnime/blob/master/work.png)


# Cloudflare Page

## 部署流程

1. 把代码推到 GitHub，确保新增的 functions/、server/、public/_routes.json 都提
    交上去。

2. 打开 Cloudflare Dashboard：
    Workers & Pages -> Create application -> Pages -> Connect to Git

3. 选择你的 GitHub 仓库和分支。
4. 构建设置填：

Framework preset: Vite 或 None
Build command: npm run build
Build output directory: dist
Root directory: /

5. Node 版本建议显式设置一个环境变量：

NODE_VERSION=22.16.0

Cloudflare 当前 v3 build image 默认 Node 22.16.0，但显式设置可以避免构建环境切
换造成 Vite 版本不兼容。

6. 点击 Deploy。
7. 部署后测试这两个地址：
https://你的项目.pages.dev/api/bangumi/subjects/1

能返回 JSON 后，主页随机功能就应该可用。