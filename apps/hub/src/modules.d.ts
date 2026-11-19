// wrangler 把 .html 当文本模块打包（默认规则），导入得到整页的字符串
declare module '*.html' {
  const text: string;
  export default text;
}
