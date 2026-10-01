// WebView2 宿主：环境、控制器、资源服务与消息桥接。
#include "mn.h"

#include <shlwapi.h>
#include <windowsx.h>

#include "WebView2.h"
#include <string>
#include <vector>
#include <tlhelp32.h>

// ------------------------------------------------------------- COM 垫片
// WRL 仅 MSVC 可用；这是每个处理器都需要的样板代码。
#define IMPL_IUNKNOWN(IFACE)                                                        \
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override      \
    {                                                                               \
        if (!ppv) { return E_POINTER; }                                             \
        if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, __uuidof(IFACE))) {  \
            *ppv = static_cast<IFACE*>(this);                                       \
            AddRef();                                                               \
            return S_OK;                                                            \
        }                                                                           \
        *ppv = nullptr;                                                             \
        return E_NOINTERFACE;                                                       \
    }                                                                               \
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&ref_); } \
    ULONG STDMETHODCALLTYPE Release() override                                      \
    {                                                                               \
        ULONG left = InterlockedDecrement(&ref_);                                   \
        if (left == 0) { delete this; }                                             \
        return left;                                                                \
    }

namespace {

ComPtr<ICoreWebView2Environment> g_environment;

// 浏览器进程独立于本进程运行，并占用着用户数据目录。关闭控制器只是请求它退出，
// 而这一过程是异步的，因此尚在关闭中的进程会在窗口消失后仍然锁住
// cNote.data。把它放入随窗口关闭而终止的作业对象，可以让清理立即、无条件地
// 完成。
HANDLE g_browserJob = nullptr;

void AssignBrowserToJob(UINT32 processId)
{
    if (!g_browserJob || !processId) { return; }

    HANDLE process = OpenProcess(
        PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION, FALSE, processId);
    if (!process) { return; }

    AssignProcessToJobObject(g_browserJob, process);
    CloseHandle(process);
}

void TrackBrowserProcess(ICoreWebView2* webview)
{
    if (!webview) { return; }

    if (!g_browserJob) {
        g_browserJob = CreateJobObjectW(nullptr, nullptr);
        if (g_browserJob) {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(g_browserJob, JobObjectExtendedLimitInformation,
                                    &limits, sizeof(limits));
        }
    }

    UINT32 processId = 0;
    if (SUCCEEDED(webview->get_BrowserProcessId(&processId))) {
        AssignBrowserToJob(processId);
    }
}
ComPtr<ICoreWebView2Controller> g_controller;
ComPtr<ICoreWebView2> g_webview;
// 在进程的整个生命周期内持有：创建环境时会自行增加引用，
// 而该对象必须比异步启动过程存活得更久。
ComPtr<ICoreWebView2EnvironmentOptions> g_environmentOptions;

// ".localhost" 由 Chromium 特殊处理，绝不会走网络解析；
// ".local" 保留给 mDNS，会引发组播查询。
const wchar_t* kAppHost = L"cnote.localhost";
const wchar_t* kDocPrefix = L"@doc/";

std::wstring MimeForPath(const std::wstring& path)
{
    std::wstring lower = path;
    for (wchar_t& ch : lower) { ch = LowerCase(ch); }

    struct { const wchar_t* ext; const wchar_t* mime; } table[] = {
        { L".png",  L"image/png" },
        { L".jpg",  L"image/jpeg" },
        { L".jpeg", L"image/jpeg" },
        { L".gif",  L"image/gif" },
        { L".webp", L"image/webp" },
        { L".bmp",  L"image/bmp" },
        { L".svg",  L"image/svg+xml" },
        { L".ico",  L"image/x-icon" },
        { L".avif", L"image/avif" },
        { L".pdf",  L"application/pdf" },
        { L".mp4",  L"video/mp4" },
        { L".webm", L"video/webm" },
        { L".mp3",  L"audio/mpeg" },
        { L".wav",  L"audio/wav" },
        { L".css",  L"text/css; charset=utf-8" },
        { L".js",   L"text/javascript; charset=utf-8" },
        { L".json", L"application/json; charset=utf-8" },
        { L".txt",  L"text/plain; charset=utf-8" },
        { L".md",   L"text/plain; charset=utf-8" },
    };

    for (const auto& entry : table) {
        if (EndsWithNoCase(lower, entry.ext)) { return entry.mime; }
    }
    return L"application/octet-stream";
}

// 对 @doc/ 路由做百分号解码。
std::wstring DecodePath(const std::wstring& text)
{
    std::string utf8;
    for (size_t i = 0; i < text.size(); ++i) {
        if (text[i] == L'%' && i + 2 < text.size()) {
            auto hex = [](wchar_t ch) -> int {
                if (ch >= L'0' && ch <= L'9') { return ch - L'0'; }
                if (ch >= L'a' && ch <= L'f') { return ch - L'a' + 10; }
                if (ch >= L'A' && ch <= L'F') { return ch - L'A' + 10; }
                return -1;
            };
            int hi = hex(text[i + 1]);
            int lo = hex(text[i + 2]);
            if (hi >= 0 && lo >= 0) {
                utf8 += static_cast<char>((hi << 4) | lo);
                i += 2;
                continue;
            }
        }
        // URL 的其余部分本身就是 UTF-8。
        std::wstring single(1, text[i]);
        utf8 += WideToUtf8(single);
    }
    return Utf8ToWide(utf8);
}

bool UnderDirectory(const std::wstring& candidate, const std::wstring& root)
{
    if (root.empty()) { return false; }
    std::wstring a = candidate;
    std::wstring b = root;
    for (wchar_t& ch : a) { ch = LowerCase(ch); if (ch == L'/') { ch = L'\\'; } }
    for (wchar_t& ch : b) { ch = LowerCase(ch); if (ch == L'/') { ch = L'\\'; } }
    if (!b.empty() && b.back() != L'\\') { b += L'\\'; }
    return a.compare(0, b.size(), b) == 0;
}

ICoreWebView2WebResourceResponse* MakeResponse(ICoreWebView2Environment* environment,
                                               const void* data, unsigned size,
                                               int status, const wchar_t* reason,
                                               const std::wstring& headers)
{
    IStream* stream = nullptr;
    if (data && size) { stream = SHCreateMemStream(static_cast<const BYTE*>(data), size); }

    ICoreWebView2WebResourceResponse* response = nullptr;
    environment->CreateWebResourceResponse(stream, status, reason, headers.c_str(), &response);
    if (stream) { stream->Release(); }
    return response;
}

}  // namespace

ICoreWebView2* HostWebView() { return g_webview.Get(); }
ICoreWebView2Environment* HostEnvironment() { return g_environment.Get(); }

namespace {

COREWEBVIEW2_COLOR ParseColor(const std::string& text)
{
    COREWEBVIEW2_COLOR color = { 255, 0xF7, 0xF5, 0xF0 };
    std::string hex = text;
    if (!hex.empty() && hex[0] == '#') { hex = hex.substr(1); }
    if (hex.size() == 6) {
        unsigned value = static_cast<unsigned>(strtoul(hex.c_str(), nullptr, 16));
        color.R = static_cast<BYTE>((value >> 16) & 0xFF);
        color.G = static_cast<BYTE>((value >> 8) & 0xFF);
        color.B = static_cast<BYTE>(value & 0xFF);
    }
    return color;
}

}  // namespace

void FocusWebContent()
{
    if (g_controller) {
        g_controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
    }
}

void ApplyBackgroundColor()
{
    if (!g_controller) { return; }
    ComPtr<ICoreWebView2Controller2> modern;
    if (FAILED(g_controller->QueryInterface(__uuidof(ICoreWebView2Controller2),
                                            reinterpret_cast<void**>(modern.Put())))) {
        return;
    }
    modern->put_DefaultBackgroundColor(
        ParseColor(g_host.config.StringOr("background", "#F7F5F0")));
}

// ------------------------------------------------------- 资源服务
class ResourceHandler : public ICoreWebView2WebResourceRequestedEventHandler {
public:
    IMPL_IUNKNOWN(ICoreWebView2WebResourceRequestedEventHandler)

    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2* sender,
                                     ICoreWebView2WebResourceRequestedEventArgs* args) override
    {
        ComPtr<ICoreWebView2WebResourceRequest> request;
        if (FAILED(args->get_Request(request.Put())) || !request) { return S_OK; }

        PWSTR uri = nullptr;
        if (FAILED(request->get_Uri(&uri)) || !uri) { return S_OK; }
        std::wstring full(uri);
        CoTaskMemFree(uri);

        std::wstring prefix = std::wstring(L"https://") + kAppHost + L"/";
        if (full.compare(0, prefix.size(), prefix) != 0) { return S_OK; }

        std::wstring path = full.substr(prefix.size());
        size_t query = path.find_first_of(L"?#");
        if (query != std::wstring::npos) { path = path.substr(0, query); }

        if (path.compare(0, wcslen(kDocPrefix), kDocPrefix) == 0) {
            std::wstring relative = DecodePath(path.substr(wcslen(kDocPrefix)));
            for (wchar_t& ch : relative) { if (ch == L'/') { ch = L'\\'; } }

            if (g_host.docDir.empty()) {
                args->put_Response(MakeResponse(g_environment.Get(), nullptr, 0, 404, L"Not Found",
                                                L"Content-Type: text/plain"));
                return S_OK;
            }

            std::wstring combined = JoinPath(g_host.docDir, relative);
            wchar_t resolved[MAX_PATH * 2];
            DWORD length = GetFullPathNameW(combined.c_str(), MAX_PATH * 2, resolved, nullptr);
            if (length == 0 || length >= MAX_PATH * 2) {
                args->put_Response(MakeResponse(g_environment.Get(), nullptr, 0, 400, L"Bad Request",
                                                L"Content-Type: text/plain"));
                return S_OK;
            }

            // 绝不允许笔记访问自身目录之外的内容。
            if (!UnderDirectory(resolved, g_host.docDir)) {
                args->put_Response(MakeResponse(g_environment.Get(), nullptr, 0, 403, L"Forbidden",
                                                L"Content-Type: text/plain"));
                return S_OK;
            }

            std::vector<unsigned char> bytes;
            if (!ReadFileBytes(resolved, &bytes)) {
                args->put_Response(MakeResponse(g_environment.Get(), nullptr, 0, 404, L"Not Found",
                                                L"Content-Type: text/plain"));
                return S_OK;
            }

            std::wstring headers = L"Content-Type: " + MimeForPath(resolved) + L"\r\nCache-Control: no-cache";
            args->put_Response(MakeResponse(g_environment.Get(), bytes.data(),
                                            static_cast<unsigned>(bytes.size()), 200, L"OK", headers));
            return S_OK;
        }

        if (path.empty()) { path = L"index.html"; }

        const char* mime = nullptr;
        unsigned size = 0;
        const void* data = AssetLookup(WideToUtf8(path), &mime, &size);
        if (!data) {
            args->put_Response(MakeResponse(g_environment.Get(), nullptr, 0, 404, L"Not Found",
                                            L"Content-Type: text/plain"));
            return S_OK;
        }

        std::wstring headers = L"Content-Type: " + Utf8ToWide(mime) + L"\r\nCache-Control: no-cache";
        args->put_Response(MakeResponse(g_environment.Get(), data, size, 200, L"OK", headers));
        return S_OK;
    }

private:
    LONG ref_ = 1;
};

// ------------------------------------------------------------ 桥接事件
class MessageHandler : public ICoreWebView2WebMessageReceivedEventHandler {
public:
    IMPL_IUNKNOWN(ICoreWebView2WebMessageReceivedEventHandler)

    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2* sender,
                                     ICoreWebView2WebMessageReceivedEventArgs* args) override;

private:
    LONG ref_ = 1;
};

class NavigationHandler : public ICoreWebView2NavigationStartingEventHandler {
public:
    IMPL_IUNKNOWN(ICoreWebView2NavigationStartingEventHandler)

    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2* sender,
                                     ICoreWebView2NavigationStartingEventArgs* args) override
    {
        PWSTR uri = nullptr;
        if (FAILED(args->get_Uri(&uri)) || !uri) { return S_OK; }
        std::wstring full(uri);
        CoTaskMemFree(uri);

        std::wstring prefix = std::wstring(L"https://") + kAppHost + L"/";
        if (full.compare(0, prefix.size(), prefix) != 0) {
            args->put_Cancel(TRUE);
            if (full.compare(0, 8, L"http") == 0) {
                ShellExecuteW(nullptr, L"open", full.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
            }
        }
        return S_OK;
    }

private:
    LONG ref_ = 1;
};

class WindowOpenHandler : public ICoreWebView2NewWindowRequestedEventHandler {
public:
    IMPL_IUNKNOWN(ICoreWebView2NewWindowRequestedEventHandler)

    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2* sender,
                                     ICoreWebView2NewWindowRequestedEventArgs* args) override
    {
        PWSTR uri = nullptr;
        if (SUCCEEDED(args->get_Uri(&uri)) && uri) {
            ShellExecuteW(nullptr, L"open", uri, nullptr, nullptr, SW_SHOWNORMAL);
            CoTaskMemFree(uri);
        }
        args->put_Handled(TRUE);
        return S_OK;
    }

private:
    LONG ref_ = 1;
};

// ------------------------------------------------------------- 启动流程
namespace {

/**
 * 承载 WebView2 未以属性形式暴露的浏览器开关。
 *
 * 只有通过选项对象把开关交给运行库，才能真正传到浏览器：这里所用的运行库在
 * 缺少该对象时会忽略 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`，这些开关也
 * 从未出现在浏览器的命令行上。
 *
 * 这里不使用 WRL，因此这是该接口所需的最小 COM 实现。
 */
class EnvironmentOptions : public ICoreWebView2EnvironmentOptions {
public:
    // 运行库会解析兼容版本号，空值会被以 E_INVALIDARG 拒绝。这是 SDK 自带
    // 选项类使用的默认值（浏览器版本，而非 SDK 版本）。
    EnvironmentOptions() : ref_(1), version_(L"126.0.2592.51"), sso_(FALSE) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override
    {
        if (!ppv) { return E_POINTER; }
        if (IsEqualIID(riid, IID_IUnknown) ||
            IsEqualIID(riid, __uuidof(ICoreWebView2EnvironmentOptions))) {
            *ppv = static_cast<ICoreWebView2EnvironmentOptions*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&ref_); }
    ULONG STDMETHODCALLTYPE Release() override
    {
        ULONG left = InterlockedDecrement(&ref_);
        if (left == 0) { delete this; }
        return left;
    }

    HRESULT STDMETHODCALLTYPE get_AdditionalBrowserArguments(LPWSTR* value) override
    {
        return CopyOut(arguments_, value);
    }
    HRESULT STDMETHODCALLTYPE put_AdditionalBrowserArguments(LPCWSTR value) override
    {
        arguments_ = value ? value : L"";
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE get_Language(LPWSTR* value) override
    {
        return CopyOut(language_, value);
    }
    HRESULT STDMETHODCALLTYPE put_Language(LPCWSTR value) override
    {
        language_ = value ? value : L"";
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE get_TargetCompatibleBrowserVersion(LPWSTR* value) override
    {
        return CopyOut(version_, value);
    }
    HRESULT STDMETHODCALLTYPE put_TargetCompatibleBrowserVersion(LPCWSTR value) override
    {
        version_ = value ? value : L"";
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE get_AllowSingleSignOnUsingOSPrimaryAccount(BOOL* value) override
    {
        if (!value) { return E_POINTER; }
        *value = sso_;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE put_AllowSingleSignOnUsingOSPrimaryAccount(BOOL value) override
    {
        sso_ = value;
        return S_OK;
    }

private:
    /** 该接口返回 CoTaskMem 字符串，由调用方负责释放。 */
    static HRESULT CopyOut(const std::wstring& text, LPWSTR* value)
    {
        if (!value) { return E_POINTER; }
        const size_t bytes = (text.size() + 1) * sizeof(wchar_t);
        auto* out = static_cast<LPWSTR>(CoTaskMemAlloc(bytes));
        if (!out) { return E_OUTOFMEMORY; }
        memcpy(out, text.c_str(), bytes);
        *value = out;
        return S_OK;
    }

    LONG ref_;
    std::wstring arguments_;
    std::wstring language_;
    std::wstring version_;
    BOOL sso_;
};

class ControllerHandler : public ICoreWebView2CreateCoreWebView2ControllerCompletedHandler {
public:
    IMPL_IUNKNOWN(ICoreWebView2CreateCoreWebView2ControllerCompletedHandler)

    HRESULT STDMETHODCALLTYPE Invoke(HRESULT errorCode, ICoreWebView2Controller* controller) override
    {
        if (FAILED(errorCode) || !controller) {
            LogLine("webview: controller creation failed");
            MessageBoxW(g_host.window,
                        L"WebView2 初始化失败。\n\n请确认系统已安装 Microsoft Edge WebView2 Runtime。",
                        L"cNote", MB_OK | MB_ICONERROR);
            PostQuitMessage(1);
            return S_OK;
        }

        g_controller.Attach(controller);
        LogLine("boot: controller " + Ms());
        controller->AddRef();
        controller->get_CoreWebView2(g_webview.Put());
        TrackBrowserProcess(g_webview.Get());

        RECT bounds;
        GetClientRect(g_host.window, &bounds);
        controller->put_Bounds(bounds);
        // 接着由 ResizeWebView 去掉调整大小的边框；否则内容区会重新占据
        // 窗口边缘。
        ResizeWebView();
        controller->put_IsVisible(TRUE);

        // 若无这一步，窗口虽处于激活状态，网页内容却没有获得焦点，
        // 用户最先输入的内容会不知去向。
        FocusWebContent();
        ApplyBackgroundColor();

        ComPtr<ICoreWebView2Settings> settings;
        if (SUCCEEDED(g_webview->get_Settings(settings.Put())) && settings) {
            settings->put_AreDefaultContextMenusEnabled(FALSE);
            settings->put_AreDevToolsEnabled(FALSE);
            settings->put_IsStatusBarEnabled(FALSE);
            settings->put_IsZoomControlEnabled(FALSE);

            // 让 Ctrl+P / Ctrl+F 留在应用内；剪贴板与撤销仍走系统默认行为。
            // 该标志位于带版本号的设置接口上。
            ComPtr<ICoreWebView2Settings3> modern;
            if (SUCCEEDED(settings->QueryInterface(__uuidof(ICoreWebView2Settings3),
                                                   reinterpret_cast<void**>(modern.Put())))) {
                modern->put_AreBrowserAcceleratorKeysEnabled(FALSE);
            }
        }

        EventRegistrationToken token;
        g_webview->add_WebMessageReceived(new MessageHandler(), &token);
        g_webview->add_NavigationStarting(new NavigationHandler(), &token);
        g_webview->add_NewWindowRequested(new WindowOpenHandler(), &token);

        g_webview->AddWebResourceRequestedFilter(
            (std::wstring(L"https://") + kAppHost + L"/*").c_str(),
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
        g_webview->add_WebResourceRequested(new ResourceHandler(), &token);

        g_webview->Navigate((std::wstring(L"https://") + kAppHost + L"/index.html").c_str());
        return S_OK;
    }

private:
    LONG ref_ = 1;
};

class EnvironmentHandler : public ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler {
public:
    IMPL_IUNKNOWN(ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler)

    HRESULT STDMETHODCALLTYPE Invoke(HRESULT errorCode, ICoreWebView2Environment* environment) override
    {
        if (FAILED(errorCode) || !environment) {
            LogLine("webview: environment creation failed");
            MessageBoxW(g_host.window,
                        L"WebView2 初始化失败。\n\n请确认系统已安装 Microsoft Edge WebView2 Runtime。",
                        L"cNote", MB_OK | MB_ICONERROR);
            PostQuitMessage(1);
            return S_OK;
        }

        g_environment.Attach(environment);
        LogLine("boot: environment " + Ms());
        environment->AddRef();

        auto* handler = new ControllerHandler();
        environment->CreateCoreWebView2Controller(g_host.window, handler);
        handler->Release();
        return S_OK;
    }

private:
    LONG ref_ = 1;
};

}  // namespace

// ------------------------------------------------- 遗留的浏览器进程
//
// 一个用户数据目录同一时间只能被一个浏览器进程使用，因此被强杀而非正常关闭的
// 实例所遗留的浏览器进程，会让下一次 CreateCoreWebView2Controller 一直阻塞到
// 它退出：启动时白白卡上数秒，而界面上没有任何提示解释这段等待。cNote 是单
// 实例应用，所以任何命令行中出现本程序配置目录的 msedgewebview2.exe，都属于
// 一个已经结束的实例。在这里结束这些进程，应用才不会继承自己留下的残骸。

typedef LONG(NTAPI* NtQueryInformationProcessFn)(HANDLE, ULONG, PVOID, ULONG, PULONG);

// WIN32_LEAN_AND_MEAN 把 winternl.h 挡在外面，而这里只需要
// ProcessCommandLineInformation 返回结构中的一个字段。
struct MnUnicodeString {
    USHORT Length;
    USHORT MaximumLength;
    PWSTR Buffer;
};

bool ProcessCommandLine(HANDLE process, std::wstring* out)
{
    static NtQueryInformationProcessFn query = nullptr;
    static bool resolved = false;
    if (!resolved) {
        resolved = true;
        HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
        if (ntdll) {
            query = reinterpret_cast<NtQueryInformationProcessFn>(
                GetProcAddress(ntdll, "NtQueryInformationProcess"));
        }
    }
    if (!query) { return false; }

    // ProcessCommandLineInformation 返回的 UNICODE_STRING 指向我们传入的
    // 缓冲区，因此第一次调用同时也是在探测所需大小。
    const ULONG kProcessCommandLineInformation = 60;
    std::vector<unsigned char> buffer(2048);
    ULONG needed = 0;
    LONG status = query(process, kProcessCommandLineInformation,
                        buffer.data(), static_cast<ULONG>(buffer.size()), &needed);
    if (status < 0 && needed > buffer.size()) {
        buffer.resize(needed);
        status = query(process, kProcessCommandLineInformation,
                       buffer.data(), static_cast<ULONG>(buffer.size()), &needed);
    }
    if (status < 0) { return false; }

    auto* info = reinterpret_cast<MnUnicodeString*>(buffer.data());
    if (!info->Buffer || info->Length == 0) { return false; }
    out->assign(info->Buffer, info->Length / sizeof(wchar_t));
    return true;
}

int ReapOrphanedBrowsers(const std::wstring& profile)
{
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) { return 0; }

    PROCESSENTRY32W entry = {};
    entry.dwSize = sizeof(entry);
    int reaped = 0;
    if (Process32FirstW(snapshot, &entry)) {
        do {
            if (CompareNoCase(entry.szExeFile, L"msedgewebview2.exe") != 0) { continue; }

            HANDLE process = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE,
                FALSE, entry.th32ProcessID);
            if (!process) { continue; }

            std::wstring command;
            if (ProcessCommandLine(process, &command) &&
                command.find(profile) != std::wstring::npos) {
                if (TerminateProcess(process, 0)) {
                    ++reaped;
                    // 下一次创建环境会等待该进程真正退出，
                    // 所以这里要等它结束，不要抢跑。
                    WaitForSingleObject(process, 5000);
                }
            }
            CloseHandle(process);
        } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return reaped;
}

bool StartWebView(HWND window)
{
    // 加载器在运行时解析，因此不需要导入库，可以直接放在可执行文件旁边
    // （也可以从可执行文件中提取）。
    // WebView2 的配置目录与配置文件放在一起，这样便携版目录自成一体，
    // 不会混入缓存。
    std::wstring profile = JoinPath(g_host.dataDir, L"cNote.data");
    CreateDirectoryW(profile.c_str(), nullptr);

    // 仅在别无实例运行时执行：如果还有另一个 cNote 在运行，使用该配置目录的
    // 浏览器进程属于它，而不是残骸。
    if (g_host.soleInstance) {
        int reaped = ReapOrphanedBrowsers(profile);
        if (reaped) {
            LogLine("webview: reaped " + std::to_string(reaped) +
                    " orphaned browser process(es) holding the profile");
        }
    }

    // WebView2 启动浏览器进程前需要的开关。没有它们，浏览器会先走
    // SmartScreen / 首次运行流程，然后才允许页面运行。环境变量中已有的值会被
    // 追加而不是覆盖：调用方正是借此传入 WebView2 未以选项形式暴露的浏览器
    // 开关。
    std::wstring browserArguments =
        L"--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-pinch";
    DWORD inherited = GetEnvironmentVariableW(L"WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", nullptr, 0);
    if (inherited > 1) {
        std::wstring extra(inherited, L'\0');
        DWORD length = GetEnvironmentVariableW(L"WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                                               &extra[0], inherited);
        extra.resize(length);
        if (!extra.empty()) { browserArguments += L" " + extra; }
    }

    auto* options = new EnvironmentOptions();
    options->put_AdditionalBrowserArguments(browserArguments.c_str());
    g_environmentOptions.Attach(options);

    // WebView2.h 把它作为 extern "C" 入口点的内联封装提供，因此这里直接内联
    // 调用，由链接器从 WebView2LoaderStatic.lib 中取实现。
    auto createEnvironment = [](PCWSTR browserFolder, PCWSTR userDataFolder,
                                ICoreWebView2EnvironmentOptions* options,
                                ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler* done) {
        return CreateCoreWebView2EnvironmentWithOptions(browserFolder, userDataFolder, options, done);
    };
    LogLine("webview: statically linked loader");
    if (!createEnvironment) {
        LogLine("webview: loader entry point missing");
        return false;
    }

    auto* handler = new EnvironmentHandler();
    HRESULT hr = createEnvironment(nullptr, profile.c_str(), g_environmentOptions.Get(), handler);
    handler->Release();

    if (FAILED(hr)) {
        std::string code = "webview: environment call failed, hr=0x";
        AppendNumber(code, static_cast<unsigned long>(hr), 16, 8, true);
        LogLine(code);
    }
    return SUCCEEDED(hr);
}

void ShutdownWebView()
{
    // 只有 Close() 才会让浏览器进程退出。仅释放接口的话，它会自行慢慢收尾，
    // 代价则由下一次启动承担：CreateCoreWebView2Controller 会按用户数据目录
    // 串行化，因此上一个实例遗留的浏览器进程可能让控制器卡住数秒。
    if (g_controller) { g_controller->Close(); }
    g_webview.Reset();
    g_controller.Reset();
    g_environment.Reset();
}

void ResizeWebView()
{
    if (!g_controller || !g_host.window) { return; }
    RECT bounds;
    GetClientRect(g_host.window, &bounds);
    // 内容区向边框内缩，好让窗口框架自己保住边缘。上面的子类化本意是让这一步
    // 变得多余，但网页视图的窗口无法被可靠地枚举，子类窗口过程收不到消息，
    // 而系统看不到的边缘就是拖不动的边缘。
    int border = ResizeBorderFor(g_host.window);
    bounds.left += border;
    bounds.top += border;
    bounds.right -= border;
    bounds.bottom -= border;
    g_controller->put_Bounds(bounds);
}

void PostReply(long long id, const Json& payload, const std::string& error)
{
    if (!g_webview) { return; }

    Json response = Json::Object();
    response.Set("id", Json::Number(static_cast<double>(id)));
    response.Set("ok", Json::Bool(error.empty()));
    if (error.empty()) { response.Set("data", payload); } else { response.Set("error", Json::Str(error)); }

    g_webview->PostWebMessageAsJson(Utf8ToWide(response.Dump()).c_str());
}

void PostEventToPage(const wchar_t* json)
{
    if (g_webview && json) { g_webview->PostWebMessageAsJson(json); }
}

void PostEventFromAnyThread(const std::string& jsonUtf8)
{
    if (!g_host.window) { return; }
    // WebView2 绑定在公寓线程上；工作线程不直接调用控件，
    // 而是把文本交给窗口线程处理。
    auto* payload = new std::wstring(Utf8ToWide(jsonUtf8));
    if (!PostMessageW(g_host.window, kPostEventMessage, 0, reinterpret_cast<LPARAM>(payload))) {
        delete payload;
    }
}

HRESULT STDMETHODCALLTYPE MessageHandler::Invoke(ICoreWebView2* sender,
                                                 ICoreWebView2WebMessageReceivedEventArgs* args)
{
    PWSTR raw = nullptr;
    if (FAILED(args->TryGetWebMessageAsString(&raw)) || !raw) { return S_OK; }
    ULONGLONG received = GetTickCount64();
    std::string text = WideToUtf8(raw);
    CoTaskMemFree(raw);
    ULONGLONG decoded = GetTickCount64();

    bool ok = false;
    Json request = Json::Parse(text, &ok);
    if (!ok || !request.IsObject()) { return S_OK; }
    ULONGLONG parsed = GetTickCount64();

    const Json* idNode = request.Find("id");
    long long id = idNode ? static_cast<long long>(idNode->AsNumber()) : 0;
    std::string command = request.StringOr("cmd", "");
    const Json* dataNode = request.Find("data");
    Json data = dataNode ? *dataNode : Json::Object();

    CommandResult result = HandleCommand(command, data, id);
    if (!result.deferred) { PostReply(id, result.payload, result.error); }
    ULONGLONG handled = GetTickCount64();

    // 一次保存会通过 JSON 双向传送整个文档，所以命令耗时较长时，
    // 应当能够查明原因，而不是靠猜。
    ULONGLONG total = handled - received;
    if (total >= 50) {
        LogLine("cmd " + command + " " + std::to_string(total) + "ms (decode " +
                std::to_string(decoded - received) + ", parse " + std::to_string(parsed - decoded) +
                ", handle " + std::to_string(handled - parsed) + ", " +
                std::to_string(text.size()) + " bytes)");
    }
    return S_OK;
}
