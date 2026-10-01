// 窗口、自定义标题栏与消息循环。
#include "mn.h"

#include <dwmapi.h>
#include <windowsx.h>
#include <algorithm>
#include <cstdio>
#include <cstdlib>

#ifndef DWMWA_WINDOW_CORNER_PREFERENCE
#define DWMWA_WINDOW_CORNER_PREFERENCE 33
#endif

namespace {

/**
 * 强制使用直角。
 *
 * Windows 11 会把可调整大小窗口的边框画成圆角，而“角偏好”属性并不总是被
 * 遵守。窗口区域一定有效，代价是需要随窗口一起调整大小。
 */
void ApplySquareRegion(HWND hwnd)
{
    RECT bounds;
    GetWindowRect(hwnd, &bounds);
    HRGN region = CreateRectRgn(0, 0, bounds.right - bounds.left, bounds.bottom - bounds.top);
    if (region) { SetWindowRgn(hwnd, region, TRUE); }
}

const wchar_t* kWindowClass = L"cNoteWindow";
const DWORD kCopyDataOpenPath = 0x4D4E3031;  // 'MN01'

HMONITOR g_monitor = nullptr;

}  // namespace

HBRUSH g_backgroundBrush = nullptr;

/** 当前主题的边框颜色，以 COLORREF 表示。 */
COLORREF ThemeColor()
{
    std::string hex = g_host.config.StringOr("background", "#F7F5F0");
    if (!hex.empty() && hex[0] == '#') { hex = hex.substr(1); }
    if (hex.size() != 6) { return RGB(0xF7, 0xF5, 0xF0); }
    unsigned value = static_cast<unsigned>(strtoul(hex.c_str(), nullptr, 16));
    return RGB((value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF);
}

/**
 * 用主题颜色绘制窗口框架。没有背景画刷时，窗口会显示其下方的内容，
 * 直到 WebView2 画出第一帧，启动时看上去就是一下白闪。
 */
void ApplyWindowBackground()
{
    HBRUSH brush = CreateSolidBrush(ThemeColor());
    if (!brush) { return; }

    HBRUSH previous = reinterpret_cast<HBRUSH>(
        SetClassLongPtrW(g_host.window, GCLP_HBRBACKGROUND, reinterpret_cast<LONG_PTR>(brush)));
    if (previous && previous != g_backgroundBrush && previous != GetStockObject(NULL_BRUSH)) {
        DeleteObject(previous);
    }
    g_backgroundBrush = brush;
    InvalidateRect(g_host.window, nullptr, TRUE);
}

/** 当前实际使用的边框颜色，形如 "#rrggbb"。 */
std::string FrameColorHex()
{
    LOGBRUSH log = {};
    if (!g_backgroundBrush || GetObjectW(g_backgroundBrush, sizeof(log), &log) == 0) {
        return std::string();
    }
    std::string text = "#";
    AppendNumber(text, static_cast<unsigned>(log.lbColor) & 0xFF, 16, 2, false);
    AppendNumber(text, (static_cast<unsigned>(log.lbColor) >> 8) & 0xFF, 16, 2, false);
    AppendNumber(text, (static_cast<unsigned>(log.lbColor) >> 16) & 0xFF, 16, 2, false);
    return text;
}

namespace {

/**
 * 第二次启动时把文件交给已运行的窗口，而不是再开一个窗口：找到它，
 * 授予它前台权限（刚启动的进程仍持有该权限），传入路径，然后还原并聚焦它。
 *
 * 这次发送是有超时的：一个不再处理消息的窗口，绝不能把用户刚启动的进程也
 * 一起卡死。
 */
bool SignalExistingInstance(const std::wstring& file)
{
    HWND existing = FindWindowW(kWindowClass, nullptr);
    if (!existing) { return false; }

    DWORD pid = 0;
    GetWindowThreadProcessId(existing, &pid);
    if (pid) { AllowSetForegroundWindow(pid); }

    if (!file.empty()) {
        COPYDATASTRUCT data = {};
        data.dwData = kCopyDataOpenPath;
        data.cbData = static_cast<DWORD>((file.size() + 1) * sizeof(wchar_t));
        data.lpData = const_cast<wchar_t*>(file.c_str());
        DWORD_PTR ignored = 0;
        SendMessageTimeoutW(existing, WM_COPYDATA, 0, reinterpret_cast<LPARAM>(&data),
                            SMTO_ABORTIFHUNG | SMTO_BLOCK, 2000, &ignored);
    }

    if (IsIconic(existing)) { ShowWindow(existing, SW_RESTORE); }
    SetForegroundWindow(existing);
    return true;
}

std::wstring ExecutableDirectory()
{
    std::wstring buffer(MAX_PATH, L'\0');
    for (;;) {
        DWORD length = GetModuleFileNameW(nullptr, &buffer[0], static_cast<DWORD>(buffer.size()));
        if (length == 0) { return std::wstring(); }
        if (length < buffer.size() - 1) {
            buffer.resize(length);
            break;
        }
        buffer.resize(buffer.size() * 2);
    }

    size_t at = buffer.find_last_of(L"\\/");
    return at == std::wstring::npos ? buffer : buffer.substr(0, at);
}

bool DirectoryIsWritable(const std::wstring& dir)
{
    std::wstring probe = JoinPath(dir, L".mn-write-probe.tmp");
    HANDLE file = CreateFileW(probe.c_str(), GENERIC_WRITE, 0, nullptr,
                              CREATE_ALWAYS, FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, nullptr);
    if (file == INVALID_HANDLE_VALUE) { return false; }
    CloseHandle(file);
    return true;
}

std::wstring LocalAppData()
{
    std::wstring buffer(MAX_PATH, L'\0');
    DWORD length = GetEnvironmentVariableW(L"LOCALAPPDATA", &buffer[0],
                                           static_cast<DWORD>(buffer.size()));
    if (length == 0 || length >= buffer.size()) { return std::wstring(); }
    buffer.resize(length);
    return JoinPath(buffer, L"cNote");
}

// 优先便携模式：配置、日志和 WebView2 配置目录都放在 exe 旁边，
// 整个应用可以装在 U 盘里带走。该目录只读时回退到 %LOCALAPPDATA%。
void ResolveDataFolder()
{
    g_host.exeDir = ExecutableDirectory();
    if (DirectoryIsWritable(g_host.exeDir)) {
        g_host.dataDir = g_host.exeDir;
        g_host.portableData = true;
    } else {
        g_host.dataDir = LocalAppData();
        g_host.portableData = false;
    }
    CreateDirectoryW(g_host.dataDir.c_str(), nullptr);
}

void ResolveStartupFile()
{
    int count = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!argv) { return; }
    for (int i = 1; i < count; ++i) {
        if (argv[i][0] == L'-') { continue; }
        DWORD attributes = GetFileAttributesW(argv[i]);
        if (attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY)) {
            wchar_t resolved[MAX_PATH * 2];
            if (GetFullPathNameW(argv[i], MAX_PATH * 2, resolved, nullptr)) {
                g_host.startupFile = resolved;
            }
            break;
        }
    }
    LocalFree(argv);
}

void SaveWindowPlacement()
{
    WINDOWPLACEMENT placement = {};
    placement.length = sizeof(placement);
    if (!GetWindowPlacement(g_host.window, &placement)) { return; }

    RECT bounds = placement.rcNormalPosition;
    bool maximized = placement.showCmd == SW_SHOWMAXIMIZED;
    // 按读取时的单位保存：逻辑像素，这样同一份配置在不同缩放的显示器上使用时，
    // 窗口的外观大小保持不变。
    const UINT dpi = GetDpiForWindow(g_host.window);

    Json window = Json::Object();
    window.Set("X", Json::Number(bounds.left));
    window.Set("Y", Json::Number(bounds.top));
    window.Set("Width", Json::Number(UnscaleForDpi(static_cast<int>(bounds.right - bounds.left), dpi)));
    window.Set("Height", Json::Number(UnscaleForDpi(static_cast<int>(bounds.bottom - bounds.top), dpi)));
    window.Set("Maximized", Json::Bool(maximized));

    g_host.config.Set("window", window);
    SaveConfig();
}

const int kDefaultWindowWidth = 1280;
const int kDefaultWindowHeight = 840;
const int kMinWindowWidth = 620;
const int kMinWindowHeight = 420;

struct Placement {
    int x = CW_USEDEFAULT;
    int y = CW_USEDEFAULT;
    int width = kDefaultWindowWidth;
    int height = kDefaultWindowHeight;
    bool maximized = false;
};

/**
 * 把窗口居中到鼠标所在的显示器。位置记录只保存尺寸：窗口每次都应开在屏幕
 * 中央，而不是上次随手留下的位置。
 */
void CentreOnActiveMonitor(Placement* placement)
{
    POINT cursor;
    if (!GetCursorPos(&cursor)) { cursor.x = cursor.y = 0; }

    HMONITOR monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTOPRIMARY);
    MONITORINFO info = {};
    info.cbSize = sizeof(info);
    if (!GetMonitorInfoW(monitor, &info)) { return; }

    RECT work = info.rcWork;
    const int workWidth = static_cast<int>(work.right - work.left);
    const int workHeight = static_cast<int>(work.bottom - work.top);
    int width = std::min(placement->width, workWidth);
    int height = std::min(placement->height, workHeight);

    placement->width = width;
    placement->height = height;
    placement->x = static_cast<int>(work.left) + (workWidth - width) / 2;
    placement->y = static_cast<int>(work.top) + (workHeight - height) / 2;
    if (placement->x < work.left) { placement->x = work.left; }
    if (placement->y < work.top) { placement->y = work.top; }
}

// 必须在 CreateWindowEx 之前读取：第一次调用 ShowWindow 会套用 STARTUPINFO
// 中的默认值，因此此前用 SetWindowPos 设置的内容都会被丢弃。
Placement ReadWindowPlacement()
{
    Placement placement;
    const Json* window = g_host.config.Find("window");
    if (window) {
        placement.width = static_cast<int>(window->NumberOr("Width", kDefaultWindowWidth));
        placement.height = static_cast<int>(window->NumberOr("Height", kDefaultWindowHeight));
        placement.maximized = window->BoolOr("Maximized", false);
    }

    // 配置中存放的是逻辑像素；而窗口以物理像素创建。
    const UINT dpi = GetDpiForSystem();
    placement.width = ScaleForDpi(placement.width, dpi);
    placement.height = ScaleForDpi(placement.height, dpi);
    if (placement.width < ScaleForDpi(kMinWindowWidth, dpi) ||
        placement.height < ScaleForDpi(kMinWindowHeight, dpi)) {
        placement.width = ScaleForDpi(kDefaultWindowWidth, dpi);
        placement.height = ScaleForDpi(kDefaultWindowHeight, dpi);
    }
    CentreOnActiveMonitor(&placement);
    return placement;
}

void KeepMaximizedInsideWorkArea(HWND hwnd, LPARAM lParam)
{
    HMONITOR monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    MONITORINFO info = {};
    info.cbSize = sizeof(info);
    if (!GetMonitorInfoW(monitor, &info)) { return; }

    auto* limits = reinterpret_cast<MINMAXINFO*>(lParam);
    RECT work = info.rcWork;
    RECT full = info.rcMonitor;

    limits->ptMaxPosition.x = work.left - full.left;
    limits->ptMaxPosition.y = work.top - full.top;
    limits->ptMaxSize.x = work.right - work.left;
    limits->ptMaxSize.y = work.bottom - work.top;
    // MINMAXINFO 使用物理像素，因此最小尺寸必须随显示器缩放，否则在 150%
    // 缩放的屏幕上，窗口可以缩到所需布局的三分之二。
    const UINT dpi = GetDpiForWindow(hwnd);
    limits->ptMinTrackSize.x = ScaleForDpi(kMinWindowWidth, dpi);
    limits->ptMinTrackSize.y = ScaleForDpi(kMinWindowHeight, dpi);
    limits->ptMaxTrackSize.x = full.right - full.left;
    limits->ptMaxTrackSize.y = full.bottom - full.top;
}

LRESULT HitTest(HWND hwnd, POINT screen)
{
    RECT window;
    GetWindowRect(hwnd, &window);

    int border = ResizeBorderFor(hwnd);

    bool left = screen.x < window.left + border;
    bool right = screen.x >= window.right - border;
    bool top = screen.y < window.top + border;
    bool bottom = screen.y >= window.bottom - border;

    if (IsZoomed(hwnd)) { left = right = top = bottom = false; }

    if (top && left) { return HTTOPLEFT; }
    if (top && right) { return HTTOPRIGHT; }
    if (bottom && left) { return HTBOTTOMLEFT; }
    if (bottom && right) { return HTBOTTOMRIGHT; }
    if (left) { return HTLEFT; }
    if (right) { return HTRIGHT; }
    if (top) { return HTTOP; }
    if (bottom) { return HTBOTTOM; }

    // 当光标位于通过 WM_NCHITTEST 上报的最大化按钮上时，
    // Windows 11 会显示贴靠布局。
    if (g_host.maximizeHover && !IsZoomed(hwnd)) { return HTMAXBUTTON; }

    return HTCLIENT;
}

LRESULT CALLBACK WndProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam)
{
    switch (message) {
    case WM_NCCALCSIZE:
        if (wParam == TRUE) {
            // 完全去掉标准窗口框架；标题栏由前端绘制。窗口通过样式保留调整大小
            // 的边框，因此边缘依然可拖动，而不必留下哪怕一像素的框架。
            return 0;
        }
        break;

    case WM_NCHITTEST:
        return HitTest(hwnd, POINT{ GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam) });

    case WM_GETMINMAXINFO:
        KeepMaximizedInsideWorkArea(hwnd, lParam);
        return 0;

    case WM_NCACTIVATE:
        return TRUE;

    case WM_ERASEBKGND:
        // 手工绘制，这样窗口不会残留旧像素（启动时的白闪），
        // 调整大小时也会用主题颜色填充。
        {
            RECT client;
            GetClientRect(hwnd, &client);
            FillRect(reinterpret_cast<HDC>(wParam), &client,
                     g_backgroundBrush ? g_backgroundBrush
                                       : reinterpret_cast<HBRUSH>(GetStockObject(WHITE_BRUSH)));
        }
        return 1;

    case WM_SIZE:
        ResizeWebView();
        ApplySquareRegion(hwnd);
        return 0;

    case WM_DPICHANGED: {
        // 清单申请了每显示器 DPI 感知，因此窗口在显示器之间移动时，
        // Windows 期望它采用系统建议的矩形。
        RECT* suggested = reinterpret_cast<RECT*>(lParam);
        SetWindowPos(hwnd, nullptr, suggested->left, suggested->top,
                     suggested->right - suggested->left, suggested->bottom - suggested->top,
                     SWP_NOZORDER | SWP_NOACTIVATE);
        ResizeWebView();
        return 0;
    }

    case WM_ACTIVATE:
        if (LOWORD(wParam) != WA_INACTIVE) { FocusWebContent(); }
        break;

    case WM_COPYDATA: {
        auto* data = reinterpret_cast<COPYDATASTRUCT*>(lParam);
        if (data && data->dwData == kCopyDataOpenPath && data->lpData &&
            data->cbData >= sizeof(wchar_t)) {
            std::wstring path(static_cast<const wchar_t*>(data->lpData),
                              data->cbData / sizeof(wchar_t));
            while (!path.empty() && path.back() == L'\0') { path.pop_back(); }

            if (!path.empty()) {
                Json payload = Json::Object();
                payload.Set("event", Json::Str("openPath"));
                payload.Set("path", Json::Str(WideToUtf8(path)));
                PostEventToPage(Utf8ToWide(payload.Dump()).c_str());
            }
        }

        if (IsIconic(hwnd)) { ShowWindow(hwnd, SW_RESTORE); }
        SetForegroundWindow(hwnd);
        FocusWebContent();
        return TRUE;
    }

    case kPostEventMessage: {
        auto* payload = reinterpret_cast<std::wstring*>(lParam);
        if (payload) {
            PostEventToPage(payload->c_str());
            delete payload;
        }
        return 0;
    }

    case WM_CLOSE:
        if (!g_host.allowClose) {
            // 先让前端确认未保存的内容。
            PostEventToPage(L"{\"event\":\"closeRequested\"}");
            return 0;
        }
        SaveWindowPlacement();
        DestroyWindow(hwnd);
        return 0;

    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }

    return DefWindowProcW(hwnd, message, wParam, lParam);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int showCommand)
{
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);

    ResolveDataFolder();
    ResolveStartupFile();

    // 单实例：第二次启动应当激活已在运行的窗口，而不是再启动一个副本。
    HANDLE instanceMutex = CreateMutexW(nullptr, FALSE, L"Local\\cNote.SingleInstance");
    bool sharedWithAnother = instanceMutex && GetLastError() == ERROR_ALREADY_EXISTS;
    g_host.soleInstance = !sharedWithAnother;
    if (sharedWithAnother) {
        // 另一个实例仍在运行。如果它已有窗口，就把文件交给它。
        if (SignalExistingInstance(g_host.startupFile)) {
            CloseHandle(instanceMutex);
            CoUninitialize();
            return 0;
        }

        // 它还没有窗口：要么仍在启动，要么已经在退出途中——窗口先于进程结束被
        // 销毁，因为关闭 WebView2 需要一点时间。给它一个出现的机会，
        // 这样再次点击图标会落到正在运行的窗口上，而不是凭空消失。
        for (int attempt = 0; attempt < 10; ++attempt) {
            Sleep(100);
            if (SignalExistingInstance(g_host.startupFile)) {
                CloseHandle(instanceMutex);
                CoUninitialize();
                return 0;
            }
        }

        // 已经没有可通信的对象了。继续往下走，把自己变成正在运行的实例。
    }

    LoadConfig();
    LogLine("boot: config loaded " + Ms());

    WNDCLASSEXW klass = {};
    klass.cbSize = sizeof(klass);
    klass.lpfnWndProc = WndProc;
    klass.hInstance = instance;
    klass.lpszClassName = kWindowClass;
    klass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    klass.style = CS_HREDRAW | CS_VREDRAW;
    // 客户区从第一帧起就用主题颜色绘制，此时 WebView2 还没有任何内容上屏。
    klass.hbrBackground = CreateSolidBrush(ThemeColor());
    RegisterClassExW(&klass);
    g_backgroundBrush = klass.hbrBackground;

    Placement placement = ReadWindowPlacement();
    g_host.maximizeOnStart = placement.maximized;

    // 使用去掉标题栏的 WS_OVERLAPPEDWINDOW 而非 WS_POPUP：弹出式窗口类基本
    // 没有调整大小的边框，无论命中测试如何返回，系统都不会进入尺寸调整循环，
    // 而且还得留下一像素框架才能拖动边缘。这里没有标题栏便无内容可画，
    // 调整大小的边框却依然有效。WS_EX_APPWINDOW 则保留无标题栏窗口否则会失去
    // 的任务栏按钮。
    g_host.window = CreateWindowExW(
        WS_EX_APPWINDOW,
        kWindowClass, L"cNote",
        (WS_OVERLAPPEDWINDOW & ~WS_CAPTION) | WS_CLIPCHILDREN,
        placement.x, placement.y, placement.width, placement.height,
        nullptr, nullptr, instance, nullptr);

    if (!g_host.window) {
        MessageBoxW(nullptr, L"无法创建窗口。", L"cNote", MB_OK | MB_ICONERROR);
        CoUninitialize();
        return 1;
    }

    ShowWindow(g_host.window, g_host.maximizeOnStart ? SW_SHOWMAXIMIZED : SW_SHOWNORMAL);
    UpdateWindow(g_host.window);

    // 窗口边框外观必须在窗口真正显示之后再设置：此前窗口尚未参与合成，
    // DWM 会丢弃这些属性，结果在我们绘制的直角框架外又套上一个带阴影的圆角框。
    DWORD corner = 1;  // DWMWCP_DONOTROUND（不做圆角）
    DwmSetWindowAttribute(g_host.window, DWMWA_WINDOW_CORNER_PREFERENCE, &corner, sizeof(corner));

    // Windows 11 还会在可调整大小的窗口四周画一圈细边框，即便关闭了圆角偏好，
    // 看上去仍像圆角轮廓。
    const DWORD kAttrBorderColor = 34;  // DWMWA_BORDER_COLOR（边框颜色）
    const COLORREF kColorNone = 0xFFFFFFFE;  // DWMWA_COLOR_NONE（不画边框）
    DwmSetWindowAttribute(g_host.window, kAttrBorderColor, &kColorNone, sizeof(kColorNone));

    // 不要系统阴影：无边框窗口自行绘制边缘，而 DWM 为可调整大小框架添加的
    // 投影会显示成灰色光晕。
    DWMNCRENDERINGPOLICY noShadow = DWMNCRP_DISABLED;
    DwmSetWindowAttribute(g_host.window, DWMWA_NCRENDERING_POLICY, &noShadow, sizeof(noShadow));
    LogLine("boot: window shown " + Ms());

    if (!StartWebView(g_host.window)) {
        MessageBoxW(g_host.window,
                    L"WebView2 初始化失败。\n\n请确认系统已安装 Microsoft Edge WebView2 Runtime。",
                    L"cNote", MB_OK | MB_ICONERROR);
        CoUninitialize();
        return 1;
    }

    MSG message;
    while (GetMessageW(&message, nullptr, 0, 0)) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }

    ShutdownWebView();
    CoUninitialize();
    return 0;
}
