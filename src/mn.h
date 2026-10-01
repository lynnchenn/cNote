// cNote —— C++ 宿主程序的共享声明。
//
// 前端（HTML/CSS/JS）与 C# 版本完全一致，承担全部编辑工作；本宿主负责窗口、
// WebView2 界面、文件系统与原生对话框，并使用相同的消息协议。
#pragma once

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <shobjidl.h>
#include <shellapi.h>

#include <string>
#include <vector>
#include <map>
#include <memory>

// WebView2.h 是 2 MB 的 MIDL 输出，因此凡只需要引用接口名的地方都不引入它。
struct ICoreWebView2;
struct ICoreWebView2Controller;
struct ICoreWebView2Environment;

// ------------------------------------------------------------------- ComPtr
// WRL 仅 MSVC 可用，所以这里实现持有 COM 引用所需的最小功能。
template <class T>
class ComPtr {
public:
    ComPtr() : p_(nullptr) {}
    ~ComPtr() { if (p_) { p_->Release(); } }
    ComPtr(const ComPtr&) = delete;
    ComPtr& operator=(const ComPtr&) = delete;

    T* operator->() const { return p_; }
    T* Get() const { return p_; }
    explicit operator bool() const { return p_ != nullptr; }

    T** Put() {
        if (p_) { p_->Release(); p_ = nullptr; }
        return &p_;
    }

    // 接管一个引用。
    void Attach(T* value) {
        if (p_) { p_->Release(); }
        p_ = value;
    }

    void Reset() {
        if (p_) { p_->Release(); p_ = nullptr; }
    }

private:
    T* p_;
};

// --------------------------------------------------------------------- Json
// 只实现配置文件和桥接协议所需的 JSON 功能。对象保持插入顺序，
// 这样编辑器写出的配置文件更易于阅读。
class Json {
public:
    enum class Type { Null, Bool, Number, String, Array, Object };

    Json() : type_(Type::Null), bool_(false), number_(0) {}
    static Json Bool(bool v);
    static Json Number(double v);
    static Json Str(const std::string& v);
    static Json Array();
    static Json Object();

    Type type() const { return type_; }
    bool IsNull() const { return type_ == Type::Null; }
    bool IsObject() const { return type_ == Type::Object; }
    bool IsArray() const { return type_ == Type::Array; }
    bool IsString() const { return type_ == Type::String; }

    bool AsBool(bool fallback = false) const { return type_ == Type::Bool ? bool_ : fallback; }
    double AsNumber(double fallback = 0) const { return type_ == Type::Number ? number_ : fallback; }
    const std::string& AsString() const { return string_; }
    std::string StringOr(const std::string& fallback) const {
        return type_ == Type::String ? string_ : fallback;
    }

    // 数组访问
    std::vector<Json>& items() { return items_; }
    const std::vector<Json>& items() const { return items_; }
    void push_back(const Json& value) { items_.push_back(value); }
    size_t size() const { return items_.size(); }

    // 对象访问
    Json* Find(const std::string& key);
    const Json* Find(const std::string& key) const;
    void Set(const std::string& key, const Json& value);
    const std::vector<std::pair<std::string, Json>>& members() const { return members_; }

    double NumberOr(const std::string& key, double fallback) const;
    bool BoolOr(const std::string& key, bool fallback) const;
    std::string StringOr(const std::string& key, const std::string& fallback) const;

    std::string Dump() const;
    static Json Parse(const std::string& text, bool* ok = nullptr);

private:
    Type type_;
    bool bool_;
    double number_;
    std::string string_;
    std::vector<Json> items_;
    std::vector<std::pair<std::string, Json>> members_;
};

std::string DumpPretty(const Json& value, int indent);

// 笔记文件使用的代码页。65001 表示纯 UTF-8；哨兵值表示原本带 BOM 的
// UTF-8 文件，这样保存时仍会写回 BOM。
const UINT kUtf8Bom = 65001 + 100000;

// ------------------------------------------------------------------ 字符串
std::wstring Utf8ToWide(const std::string& text);
std::string WideToUtf8(const std::wstring& text);
std::string ToLowerAscii(const std::string& text);

/**
 * 按本程序的需要把单个字符转为小写：ASCII 字母，以及使用同样 +32 偏移的
 * Latin-1 字母。
 *
 * CRT 的 towlower 对每个字符都要查 locale 表，会把数 KB 的表数据拖进可执行
 * 文件，而笔记编辑器根本用不到这种大小写折叠——何况这些文档以中日韩文字为主，
 * 本就没有大小写之分。
 */
wchar_t LowerCase(wchar_t ch);

/** 使用 LowerCase 对两个宽字符串做不区分大小写的比较。 */
int CompareNoCase(const std::wstring& a, const std::wstring& b);

bool EndsWithNoCase(const std::wstring& text, const std::wstring& suffix);
std::wstring FileNameOf(const std::wstring& path);
std::wstring DirectoryOf(const std::wstring& path);
std::wstring JoinPath(const std::wstring& dir, const std::wstring& name);

// ------------------------------------------------------------------ 宿主状态
struct HostState {
    HWND window = nullptr;
    std::wstring exeDir;
    std::wstring dataDir;
    std::wstring docDir;          // 当前文档所在目录
    bool portableData = true;

    Json config;
    bool maximizeOnStart = false;
    bool maximizeHover = false;
    bool allowClose = false;
// 启动时没有其他 cNote 实例在运行时为真。只有这种情况才能把使用本配置
    // 目录的浏览器进程视为孤儿进程。
    bool soleInstance = true;
    std::wstring startupFile;

    // 路径 -> 代码页，这样以 GBK 保存的笔记仍会以 GBK 写回。
    std::map<std::wstring, UINT> encodings;

    // 笔记尚无路径时 @doc/ 使用的备用文档目录。
    std::wstring lastFolder;
};

extern HostState g_host;

// ------------------------------------------------------------------- 资源
const void* AssetLookup(const std::string& path, const char** mime, unsigned* size);

// ------------------------------------------------------------------- 桥接
// 处理一条 {id, cmd, data} 消息。
struct CommandResult {
    Json payload;
    std::string error;
    bool deferred = false;   // 该命令完成后会自行发送回复
};

CommandResult HandleCommand(const std::string& command, const Json& data, long long id);

// ------------------------------------------------------------------ WebView
bool StartWebView(HWND window);
void ShutdownWebView();
void ResizeWebView();
// 由能看到完整 WebView2 接口的编译单元持有。
ICoreWebView2* HostWebView();
ICoreWebView2Environment* HostEnvironment();
// 避免第一次按键被窗口边框吞掉，并重新应用主题颜色，
// 使切换主题时不会闪白。
void FocusWebContent();
/**
 * 可拖动窗口边框的宽度，按窗口所在显示器缩放。
 *
 * 单位为物理像素，因此会随显示缩放而变大；固定的 7px 抓取区在 150% 缩放的
 * 屏幕上只剩几个逻辑像素。
 */
inline int ResizeBorderFor(HWND hwnd)
{
    const int kResizeBorder = 2;
    UINT dpi = GetDpiForWindow(hwnd);
    return dpi ? MulDiv(kResizeBorder, static_cast<int>(dpi), 96) : kResizeBorder;
}

/**
 * 逻辑（96 dpi）像素与物理像素之间的相互换算。
 *
 * 窗口尺寸按逻辑像素配置与记忆，这样窗口看上去的大小保持不变：1280 逻辑像素
 * 在 100% 下是 1280 px，在 150% 下是 1920 px，占屏幕的比例相同。窗口坐标本身
 * 始终是物理像素——GetWindowRect、SetWindowPos 和 MINMAXINFO 都用物理像素
 * ——所以换算只发生在两端，也就是从配置读取或写入数值的地方。
 */
inline int ScaleForDpi(int value, UINT dpi)
{
    return dpi ? MulDiv(value, static_cast<int>(dpi), 96) : value;
}

inline int UnscaleForDpi(int value, UINT dpi)
{
    return dpi ? MulDiv(value, 96, static_cast<int>(dpi)) : value;
}
void ApplyBackgroundColor();
// 用主题颜色重绘窗口边框（否则页面绘制完成前的一瞬间会显示白色矩形）。
void ApplyWindowBackground();
std::string FrameColorHex();
// 为需要异步应答的命令发送回复。
void PostReply(long long id, const Json& payload, const std::string& error);
// 向页面发送带外事件（不带 id）。
void PostEventToPage(const wchar_t* json);
// 同上，但由工作线程发起：WebView2 必须在窗口线程上调用，
// 因此改为把数据交给消息循环处理。
void PostEventFromAnyThread(const std::string& jsonUtf8);

// 把堆上分配的 std::wstring 投递给页面的窗口消息。
const UINT kPostEventMessage = WM_APP + 7;

// ------------------------------------------------------------------- 文件
bool ReadFileBytes(const std::wstring& path, std::vector<unsigned char>* bytes);
bool WriteFileText(const std::wstring& path, const std::string& utf8, UINT codePage);
bool WriteFileBytes(const std::wstring& path, const std::vector<unsigned char>& bytes);
std::string DecodeText(const std::vector<unsigned char>& bytes, UINT* codePage);
std::wstring OpenFileDialog(HWND owner, const std::wstring& initialDir);
std::wstring SaveFileDialog(HWND owner, const std::wstring& suggested, const wchar_t* filter);
std::wstring PickFolderDialog(HWND owner, const std::wstring& initialDir);

// ------------------------------------------------------------------ 配置
void LoadConfig();
void SaveConfig();

// -------------------------------------------------------------------- 杂项
// 启动计时：每个里程碑都记录自进程启动以来的毫秒数，
// 这样启动变慢时可以定位原因，而不是靠猜。
extern ULONGLONG g_startTick;
std::string Ms();
void LogLine(const std::string& line);

/**
 * 按给定进制追加 `value`，至少用零补齐到 `width` 位。
 *
 * 这些函数的存在是为了让程序完全不必动用 printf。printf 是全有或全无的：
 * 即便只写 `"%lld"` 也会链接整个格式化实现（含浮点），因为格式字符串只在
 * 运行时才被读取——实测这约占可执行文件 8 KB。
 */
void AppendNumber(std::string& out, unsigned long long value, int base, int width, bool upper);

/** 按十进制追加 `value`，为负数时带前导 '-'。 */
void AppendSigned(std::string& out, long long value, int width);
