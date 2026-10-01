// 字符串、路径、文本解码、原生对话框、配置与日志。
#include "mn.h"

#include <algorithm>
#include <cstdio>

HostState g_host;
ULONGLONG g_startTick = GetTickCount64();

std::string Ms()
{
    return std::to_string(GetTickCount64() - g_startTick) + "ms";
}

// ---------------------------------------------------------------- 字符串
std::wstring Utf8ToWide(const std::string& text)
{
    if (text.empty()) { return std::wstring(); }
    int count = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0);
    std::wstring out(static_cast<size_t>(count), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), &out[0], count);
    return out;
}

std::string WideToUtf8(const std::wstring& text)
{
    if (text.empty()) { return std::string(); }
    int count = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()),
                                    nullptr, 0, nullptr, nullptr);
    std::string out(static_cast<size_t>(count), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()),
                        &out[0], count, nullptr, nullptr);
    return out;
}

std::string ToLowerAscii(const std::string& text)
{
    std::string out = text;
    for (char& ch : out) {
        if (ch >= 'A' && ch <= 'Z') { ch = static_cast<char>(ch - 'A' + 'a'); }
    }
    return out;
}

wchar_t LowerCase(wchar_t ch)
{
    if (ch >= L'A' && ch <= L'Z') { return static_cast<wchar_t>(ch + 32); }
    // Latin-1 补充区：字母使用相同的偏移量，而 0xD7 是乘号，不是字母。
    if (ch >= 0x00C0 && ch <= 0x00DE && ch != 0x00D7) { return static_cast<wchar_t>(ch + 32); }
    return ch;
}

int CompareNoCase(const std::wstring& a, const std::wstring& b)
{
    const size_t shortest = a.size() < b.size() ? a.size() : b.size();
    for (size_t i = 0; i < shortest; ++i) {
        const wchar_t left = LowerCase(a[i]);
        const wchar_t right = LowerCase(b[i]);
        if (left != right) { return left < right ? -1 : 1; }
    }
    if (a.size() == b.size()) { return 0; }
    return a.size() < b.size() ? -1 : 1;
}

bool EndsWithNoCase(const std::wstring& text, const std::wstring& suffix)
{
    if (text.size() < suffix.size()) { return false; }
    return CompareNoCase(text.substr(text.size() - suffix.size()), suffix) == 0;
}

std::wstring FileNameOf(const std::wstring& path)
{
    size_t at = path.find_last_of(L"\\/");
    return at == std::wstring::npos ? path : path.substr(at + 1);
}

std::wstring DirectoryOf(const std::wstring& path)
{
    size_t at = path.find_last_of(L"\\/");
    return at == std::wstring::npos ? std::wstring() : path.substr(0, at);
}

std::wstring JoinPath(const std::wstring& dir, const std::wstring& name)
{
    if (dir.empty()) { return name; }
    if (!dir.empty() && (dir.back() == L'\\' || dir.back() == L'/')) { return dir + name; }
    return dir + L"\\" + name;
}

// ------------------------------------------------------------------- 文件
bool ReadFileBytes(const std::wstring& path, std::vector<unsigned char>* bytes)
{
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                              nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) { return false; }

    LARGE_INTEGER size;
    if (!GetFileSizeEx(file, &size) || size.QuadPart > (64ll << 20)) {
        CloseHandle(file);
        return false;
    }

    bytes->resize(static_cast<size_t>(size.QuadPart));
    DWORD read = 0;
    bool ok = bytes->empty() ||
        (ReadFile(file, bytes->data(), static_cast<DWORD>(bytes->size()), &read, nullptr) && read == bytes->size());
    CloseHandle(file);
    return ok;
}

namespace {

bool IsValidUtf8(const unsigned char* data, size_t size)
{
    if (size == 0) { return true; }
    int wide = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                   reinterpret_cast<const char*>(data), static_cast<int>(size), nullptr, 0);
    return wide > 0;
}

std::string FromCodePage(const unsigned char* data, size_t size, UINT codePage)
{
    if (size == 0) { return std::string(); }
    int wide = MultiByteToWideChar(codePage, 0, reinterpret_cast<const char*>(data),
                                   static_cast<int>(size), nullptr, 0);
    if (wide <= 0) { return std::string(); }
    std::wstring buffer(static_cast<size_t>(wide), L'\0');
    MultiByteToWideChar(codePage, 0, reinterpret_cast<const char*>(data), static_cast<int>(size),
                        &buffer[0], wide);
    return WideToUtf8(buffer);
}

}  // namespace

std::string DecodeText(const std::vector<unsigned char>& bytes, UINT* codePage)
{
    const unsigned char* data = bytes.data();
    size_t size = bytes.size();

    if (size >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF) {
        *codePage = kUtf8Bom;
        return FromCodePage(data + 3, size - 3, CP_UTF8);
    }
    if (size >= 2 && data[0] == 0xFF && data[1] == 0xFE) {
        *codePage = 1200;
        return FromCodePage(data + 2, size - 2, 1200);
    }
    if (size >= 2 && data[0] == 0xFE && data[1] == 0xFF) {
        *codePage = 1201;
        return FromCodePage(data + 2, size - 2, 1201);
    }
    if (IsValidUtf8(data, size)) {
        *codePage = CP_UTF8;
        return std::string(reinterpret_cast<const char*>(data), size);
    }

    // Windows 编辑器保存的旧中文文件仍以 ANSI 代码页为默认，
    // 因此这里回退到 GBK，而不是输出替换字符。
    *codePage = 936;
    return FromCodePage(data, size, 936);
}

bool WriteFileText(const std::wstring& path, const std::string& utf8, UINT codePage)
{
    std::wstring wide = Utf8ToWide(utf8);
    std::vector<unsigned char> out;

    if (codePage == CP_UTF8) {
        out.assign(utf8.begin(), utf8.end());
    } else if (codePage == kUtf8Bom) {
        out = { 0xEF, 0xBB, 0xBF };
        out.insert(out.end(), utf8.begin(), utf8.end());
    } else if (codePage == 1200 || codePage == 1201) {
        out.push_back(codePage == 1200 ? 0xFF : 0xFE);
        out.push_back(codePage == 1200 ? 0xFE : 0xFF);
        const unsigned char* raw = reinterpret_cast<const unsigned char*>(wide.data());
        const size_t count = wide.size() * 2;
        if (codePage == 1201) {
            for (size_t i = 0; i + 1 < count; i += 2) {
                out.push_back(raw[i + 1]);
                out.push_back(raw[i]);
            }
        } else {
            out.insert(out.end(), raw, raw + count);
        }
    } else {
        int count = WideCharToMultiByte(codePage, 0, wide.c_str(), static_cast<int>(wide.size()),
                                        nullptr, 0, nullptr, nullptr);
        if (count > 0) {
            out.resize(static_cast<size_t>(count));
            WideCharToMultiByte(codePage, 0, wide.c_str(), static_cast<int>(wide.size()),
                                reinterpret_cast<char*>(out.data()), count, nullptr, nullptr);
        }
    }

    std::wstring directory = DirectoryOf(path);
    if (!directory.empty()) { CreateDirectoryW(directory.c_str(), nullptr); }

    HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr,
                              CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) { return false; }

    DWORD written = 0;
    bool ok = out.empty() ||
        (WriteFile(file, out.data(), static_cast<DWORD>(out.size()), &written, nullptr) && written == out.size());
    CloseHandle(file);
    return ok;
}

bool WriteFileBytes(const std::wstring& path, const std::vector<unsigned char>& bytes)
{
    std::wstring directory = DirectoryOf(path);
    if (!directory.empty()) { CreateDirectoryW(directory.c_str(), nullptr); }

    HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr,
                              CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) { return false; }

    DWORD written = 0;
    bool ok = bytes.empty() ||
        (WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) &&
         written == bytes.size());
    CloseHandle(file);
    return ok;
}

// ----------------------------------------------------------------- 对话框
namespace {

std::wstring RunFileDialog(HWND owner, REFCLSID clsid,
                           const std::wstring& initialDir,
                           const std::wstring& suggested,
                           const COMDLG_FILTERSPEC* filters, UINT filterCount,
                           const wchar_t* defaultExtension)
{
    ComPtr<IFileDialog> dialog;
    if (FAILED(CoCreateInstance(clsid, nullptr, CLSCTX_INPROC_SERVER,
                                __uuidof(IFileDialog), reinterpret_cast<void**>(dialog.Put())))) {
        return std::wstring();
    }

    DWORD options = 0;
    dialog->GetOptions(&options);
    dialog->SetOptions(options | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
    if (filters && filterCount) { dialog->SetFileTypes(filterCount, filters); }
    if (suggested.size()) { dialog->SetFileName(suggested.c_str()); }
    if (defaultExtension && *defaultExtension) { dialog->SetDefaultExtension(defaultExtension); }

    if (initialDir.size()) {
        ComPtr<IShellItem> folder;
        if (SUCCEEDED(SHCreateItemFromParsingName(initialDir.c_str(), nullptr,
                                                  __uuidof(IShellItem),
                                                  reinterpret_cast<void**>(folder.Put())))) {
            dialog->SetFolder(folder.Get());
        }
    }

    if (FAILED(dialog->Show(owner))) { return std::wstring(); }

    ComPtr<IShellItem> result;
    if (FAILED(dialog->GetResult(result.Put())) || !result) { return std::wstring(); }

    PWSTR raw = nullptr;
    if (FAILED(result->GetDisplayName(SIGDN_FILESYSPATH, &raw)) || !raw) { return std::wstring(); }
    std::wstring path(raw);
    CoTaskMemFree(raw);
    return path;
}

}  // namespace

static const COMDLG_FILTERSPEC kMarkdownFilters[] = {
    { L"Markdown", L"*.md;*.markdown;*.mdown;*.mkd;*.txt" },
    { L"All files", L"*.*" },
};

std::wstring OpenFileDialog(HWND owner, const std::wstring& initialDir)
{
    return RunFileDialog(owner, CLSID_FileOpenDialog, initialDir, L"",
                         kMarkdownFilters, 2, L"md");
}

std::wstring SaveFileDialog(HWND owner, const std::wstring& suggested, const wchar_t* filter)
{
    COMDLG_FILTERSPEC filters[2] = {
        { L"Markdown", filter },
        { L"All files", L"*.*" },
    };
    return RunFileDialog(owner, CLSID_FileSaveDialog, g_host.lastFolder, suggested,
                         filters, 2, L"md");
}

std::wstring PickFolderDialog(HWND owner, const std::wstring& initialDir)
{
    ComPtr<IFileOpenDialog> dialog;
    if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER,
                                __uuidof(IFileOpenDialog),
                                reinterpret_cast<void**>(dialog.Put())))) {
        return std::wstring();
    }

    DWORD options = 0;
    dialog->GetOptions(&options);
    dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
    dialog->SetTitle(L"选择文件夹");

    if (initialDir.size()) {
        ComPtr<IShellItem> folder;
        if (SUCCEEDED(SHCreateItemFromParsingName(initialDir.c_str(), nullptr, __uuidof(IShellItem),
                                                  reinterpret_cast<void**>(folder.Put())))) {
            dialog->SetFolder(folder.Get());
        }
    }

    if (FAILED(dialog->Show(owner))) { return std::wstring(); }

    ComPtr<IShellItem> result;
    if (FAILED(dialog->GetResult(result.Put())) || !result) { return std::wstring(); }

    PWSTR raw = nullptr;
    if (FAILED(result->GetDisplayName(SIGDN_FILESYSPATH, &raw)) || !raw) { return std::wstring(); }
    std::wstring path(raw);
    CoTaskMemFree(raw);
    return path;
}

// ------------------------------------------------------------------ 配置
namespace {

Json DefaultConfig()
{
    Json config = Json::Object();
    config.Set("theme", Json::Str("paper"));
    config.Set("viewMode", Json::Str("split"));
    config.Set("fontSize", Json::Number(16));
    config.Set("lineHeight", Json::Number(1.75));
    config.Set("contentWidth", Json::Number(900));
    config.Set("splitRatio", Json::Number(0.5));
    config.Set("fontFamily", Json::Str(""));
    config.Set("autoSave", Json::Bool(false));
    config.Set("showLineNumbers", Json::Bool(false));
    config.Set("typewriter", Json::Bool(false));
    config.Set("focusMode", Json::Bool(false));
    config.Set("sidebar", Json::Bool(true));
    config.Set("sidebarTab", Json::Str("outline"));
    config.Set("lastFolder", Json::Str(""));
    config.Set("recent", Json::Array());
    config.Set("window", Json::Object());
    config.Set("background", Json::Str("#F7F5F0"));
    return config;
}

}  // namespace

void LoadConfig()
{
    g_host.config = DefaultConfig();

    std::vector<unsigned char> bytes;
    if (!ReadFileBytes(JoinPath(g_host.dataDir, L"cNote.config.json"), &bytes)) { return; }

    bool ok = false;
    Json parsed = Json::Parse(std::string(bytes.begin(), bytes.end()), &ok);
    if (!ok || !parsed.IsObject()) { return; }

    // 合并：文件中未包含的项一律保留默认值。
    for (const auto& entry : parsed.members()) {
        g_host.config.Set(entry.first, entry.second);
    }
}

void SaveConfig()
{
    std::string text = DumpPretty(g_host.config, 2);
    std::wstring path = JoinPath(g_host.dataDir, L"cNote.config.json");
    WriteFileText(path, text, CP_UTF8);
}

// -------------------------------------------------------------------- 杂项
namespace {

const char kDigitsLower[] = "0123456789abcdef";
const char kDigitsUpper[] = "0123456789ABCDEF";

}  // namespace

void AppendNumber(std::string& out, unsigned long long value, int base, int width, bool upper)
{
    const char* digits = upper ? kDigitsUpper : kDigitsLower;
    const unsigned step = static_cast<unsigned>(base);
    char buffer[24];
    int at = static_cast<int>(sizeof(buffer));
    do {
        buffer[--at] = digits[value % step];
        value /= step;
    } while (value);
    while (static_cast<int>(sizeof(buffer)) - at < width) { buffer[--at] = '0'; }
    out.append(buffer + at, static_cast<size_t>(static_cast<int>(sizeof(buffer)) - at));
}

void AppendSigned(std::string& out, long long value, int width)
{
    if (value < 0) {
        out += '-';
        // -LLONG_MIN 无法表示，因此取绝对值时在无符号空间中处理。
        AppendNumber(out, 0ull - static_cast<unsigned long long>(value), 10, width > 0 ? width - 1 : 0, false);
        return;
    }
    AppendNumber(out, static_cast<unsigned long long>(value), 10, width, false);
}

void LogLine(const std::string& line)
{
    if (line.empty()) { return; }

    SYSTEMTIME now;
    GetLocalTime(&now);
    std::string text = "[";
    AppendNumber(text, now.wHour, 10, 2, false);
    text += ':';
    AppendNumber(text, now.wMinute, 10, 2, false);
    text += ':';
    AppendNumber(text, now.wSecond, 10, 2, false);
    text += "] ";

    std::wstring path = JoinPath(g_host.dataDir, L"cNote.log");
    HANDLE file = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ, nullptr,
                              OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) { return; }

    text += line + "\r\n";
    DWORD written = 0;
    WriteFile(file, text.data(), static_cast<DWORD>(text.size()), &written, nullptr);
    CloseHandle(file);
}
