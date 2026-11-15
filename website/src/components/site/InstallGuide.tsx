import { container, section } from "@/components/ui/layout";
import { Code, Eyebrow, TextLink } from "@/components/ui/Text";
import { page, repoUrl } from "@/lib/site";

const steps = [
  <>从 Release 下载 Windows x64 的 <Code>.msi</Code> / <Code>.exe</Code> 安装包，或解压便携版使用。</>,
  <>安装并运行。安装包尚未签名，Windows 可能提示「未知发布者」；便携版需预先安装 WebView2 Runtime。</>,
  <>从托盘打开设置，在「壁纸」页选择场景并开启「显示壁纸」；需要音乐或音境时打开对应工具。</>,
  <>关闭窗口只是隐藏，退出请用托盘菜单的「退出」。</>,
];

const sourceCommands = `git clone https://github.com/Lull-Desktop/Lull.git
cd Lull
pnpm install --frozen-lockfile
& "C:\\Program Files\\Git\\bin\\bash.exe" src-tauri/native/build-shim.sh
pnpm build`;

/** 下载页中段：安装四步（计数器由 CSS counter 生成）+ 从源码构建 */
export default function InstallGuide() {
  return (
    <section className={section}>
      <div className={container}>
        <div className="grid grid-cols-2 gap-[18px] max-[640px]:grid-cols-1">
          <div>
            <Eyebrow>Install</Eyebrow>
            <h2 className="mb-2.5 text-h2 leading-[1.25] text-mist">安装</h2>
            <ol className="m-0 grid list-none gap-3.5 p-0 [counter-reset:step]">
              {steps.map((step, index) => (
                <li
                  key={index}
                  className="relative pl-[42px] text-[0.92rem] text-muted [counter-increment:step] before:absolute before:top-0.5 before:left-0 before:grid before:size-[26px] before:place-items-center before:rounded-full before:border before:border-line-strong before:font-mono before:text-[0.78rem] before:text-green before:content-[counter(step)]"
                >
                  {step}
                </li>
              ))}
            </ol>
          </div>
          <div>
            <Eyebrow>From source</Eyebrow>
            <h2 className="mb-2.5 text-h2 leading-[1.25] text-mist">从源码构建</h2>
            <p className="text-[0.86rem] leading-[1.7] text-muted">
              需要 Node.js 22、根 package.json 声明的 pnpm、Rust MSVC 工具链、Visual Studio「使用 C++ 的桌面开发」与 Windows SDK，以及 Git Bash。官网的 Node 要求独立维护。
            </p>
            <pre className="mt-4 mb-4 overflow-x-auto rounded-xl border border-line bg-white/[0.03] px-5 py-[18px] font-mono text-[0.84rem] leading-[1.7] text-body">
              {sourceCommands}
            </pre>
            <p className="text-[0.86rem] leading-[1.7] text-muted">
              构建细节见 <TextLink href={page("/docs/getting-started/")}>快速开始</TextLink> 与{" "}
              <TextLink href={`${repoUrl}/blob/master/docs/native-host.md`} rel="noopener">
                原生宿主说明
              </TextLink>
              。
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
