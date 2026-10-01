// 命令桥接：前端能发送的每条消息都对应一个处理分支。
#include "mn.h"

#include "WebView2.h"
#include "assets.generated.h"

#include <compressapi.h>
#include <cstdio>
#include <cstring>
#include <algorithm>
#include <urlmon.h>   // URLDownloadToFileW，用于“保存网络图片”功能

// ------------------------------------------------------------------ 资源
namespace {

// 首次使用时解码并保留：整个前端解压后有好几百 KB，而 WebView2 重新加载时会
// 再次请求同一个文件。MSZIP 就是普通的 deflate，解码器属于操作系统，
// 因此这不会给发布的可执行文件增添任何自己的代码。
std::vector<unsigned char> g_assetBytes[kAssetCount];

const void* DecodeAsset(unsigned index)
{
    const EmbeddedAsset& entry = kAssets[index];
    std::vector<unsigned char>& cached = g_assetBytes[index];
    if (!cached.empty()) { return cached.data(); }
    if (entry.size == 0) { return ""; }

    DECOMPRESSOR_HANDLE handle = nullptr;
    if (!CreateDecompressor(COMPRESS_ALGORITHM_MSZIP, nullptr, &handle)) { return nullptr; }

    cached.resize(entry.size);
    SIZE_T written = 0;
    BOOL ok = Decompress(handle, entry.packed, entry.packedSize,
                         cached.data(), entry.size, &written);
    CloseDecompressor(handle);

    if (!ok || written != entry.size) {
        cached.clear();
        return nullptr;
    }
    return cached.data();
}

}  // namespace

const void* AssetLookup(const std::string& path, const char** mime, unsigned* size)
{
    for (unsigned i = 0; i < kAssetCount; ++i) {
        if (path == kAssets[i].path) {
            *mime = kAssets[i].mime;
            *size = kAssets[i].size;
            return DecodeAsset(i);
        }
    }
    return nullptr;
}

// ------------------------------------------------------------------ base64
namespace {

bool Base64Decode(const std::string& text, std::vector<unsigned char>* out)
{
    auto value = [](char ch) -> int {
        if (ch >= 'A' && ch <= 'Z') { return ch - 'A'; }
        if (ch >= 'a' && ch <= 'z') { return ch - 'a' + 26; }
        if (ch >= '0' && ch <= '9') { return ch - '0' + 52; }
        if (ch == '+') { return 62; }
        if (ch == '/') { return 63; }
        return -1;
    };

    int accumulator = 0;
    int bits = 0;
    for (char ch : text) {
        if (ch == '=' || ch == '\n' || ch == '\r' || ch == ' ') { continue; }
        int digit = value(ch);
        if (digit < 0) { return false; }
        accumulator = (accumulator << 6) | digit;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out->push_back(static_cast<unsigned char>((accumulator >> bits) & 0xFF));
        }
    }
    return true;
}

std::string EncodingName(UINT codePage)
{
    switch (codePage) {
    case CP_UTF8:
    case kUtf8Bom: return "utf-8";
    case 1200:     return "utf-16";
    case 1201:     return "utf-16BE";
    default:       return "gb2312";
    }
}

Json FilePayload(const std::wstring& path, const std::string& text, UINT codePage, size_t bytes)
{
    Json payload = Json::Object();
    payload.Set("path", Json::Str(WideToUtf8(path)));
    payload.Set("name", Json::Str(WideToUtf8(FileNameOf(path))));
    payload.Set("dir", Json::Str(WideToUtf8(DirectoryOf(path))));
    payload.Set("text", Json::Str(text));
    payload.Set("encoding", Json::Str(EncodingName(codePage)));
    payload.Set("bytes", Json::Number(static_cast<double>(bytes)));
    return payload;
}

// 用同一份名单界定“什么算笔记”：目录列表、搜索和保存对话框必须保持一致，
// 否则面板中显示的文件可能无法被创建。
const wchar_t* const kNoteExtensions[] = { L".md", L".markdown", L".mdown", L".mkd", L".txt" };

bool IsNoteFile(const std::wstring& name)
{
    for (const wchar_t* ext : kNoteExtensions) {
        if (EndsWithNoCase(name, ext)) { return true; }
    }
    return false;
}

std::wstring EnsureMarkdownExtension(const std::wstring& name)
{
    return IsNoteFile(name) ? name : name + L".md";
}

bool ContainsNoCase(const std::wstring& text, const std::wstring& needle)
{
    if (needle.empty()) { return true; }
    auto same = [](wchar_t a, wchar_t b) { return LowerCase(a) == LowerCase(b); };
    return std::search(text.begin(), text.end(), needle.begin(), needle.end(), same) != text.end();
}

Json DirectoryListing(const std::wstring& path)
{
    Json entries = Json::Array();

    std::wstring pattern = JoinPath(path, L"*");
    WIN32_FIND_DATAW data;
    HANDLE find = FindFirstFileW(pattern.c_str(), &data);
    if (find != INVALID_HANDLE_VALUE) {
        std::vector<std::wstring> directories;
        std::vector<std::wstring> files;
        do {
            std::wstring name = data.cFileName;
            if (name == L"." || name == L"..") { continue; }
            if (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                if (name == L".git" || name == L"node_modules" || name == L"cNote.data") { continue; }
                directories.push_back(name);
            } else {
                if (IsNoteFile(name)) {
                    files.push_back(name);
                }
            }
        } while (FindNextFileW(find, &data));
        FindClose(find);

        auto byName = [](const std::wstring& a, const std::wstring& b) {
            return CompareNoCase(a, b) < 0;
        };
        std::sort(directories.begin(), directories.end(), byName);
        std::sort(files.begin(), files.end(), byName);

        for (const std::wstring& name : directories) {
            Json entry = Json::Object();
            entry.Set("name", Json::Str(WideToUtf8(name)));
            entry.Set("path", Json::Str(WideToUtf8(JoinPath(path, name))));
            entry.Set("dir", Json::Bool(true));
            entries.push_back(entry);
        }
        for (const std::wstring& name : files) {
            Json entry = Json::Object();
            entry.Set("name", Json::Str(WideToUtf8(name)));
            entry.Set("path", Json::Str(WideToUtf8(JoinPath(path, name))));
            entry.Set("dir", Json::Bool(false));
            entries.push_back(entry);
        }
    }

    Json listing = Json::Object();
    listing.Set("path", Json::Str(WideToUtf8(path)));
    listing.Set("entries", entries);
    return listing;
}

// 文件面板的搜索框每输入一个字符都会请求一次，因此遍历在深度和结果数量上都
// 设了上限，而不是指望目录一定很小。目录按字母顺序访问，这样用户还在输入时
// 列表不会重新排序。
void SearchFilesInto(const std::wstring& folder, const std::wstring& needle,
                     int depth, int* budget, Json* out)
{
    if (depth > 6 || *budget <= 0) { return; }

    std::wstring pattern = JoinPath(folder, L"*");
    WIN32_FIND_DATAW data;
    HANDLE find = FindFirstFileW(pattern.c_str(), &data);
    if (find == INVALID_HANDLE_VALUE) { return; }

    std::vector<std::wstring> subfolders;
    do {
        std::wstring name = data.cFileName;
        if (name == L"." || name == L"..") { continue; }
        if (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            if (name == L".git" || name == L"node_modules" || name == L"cNote.data") { continue; }
            subfolders.push_back(name);
            continue;
        }
        if (*budget <= 0) { break; }
        if (!IsNoteFile(name) || !ContainsNoCase(name, needle)) { continue; }

        std::wstring full = JoinPath(folder, name);
        Json entry = Json::Object();
        entry.Set("name", Json::Str(WideToUtf8(name)));
        entry.Set("path", Json::Str(WideToUtf8(full)));
        entry.Set("dir", Json::Str(WideToUtf8(DirectoryOf(full))));
        out->push_back(entry);
        --(*budget);
    } while (FindNextFileW(find, &data));
    FindClose(find);

    std::sort(subfolders.begin(), subfolders.end(),
              [](const std::wstring& a, const std::wstring& b) {
                  return CompareNoCase(a, b) < 0;
              });
    for (const std::wstring& sub : subfolders) {
        if (*budget <= 0) { return; }
        SearchFilesInto(JoinPath(folder, sub), needle, depth + 1, budget, out);
    }
}

// ----------------------------------------------------------- 文件监视
//
// 编辑器必须察觉已打开的笔记被其他程序改写——否则来自别的程序的保存会被悄悄
// 覆盖。单个工作线程轮询已打开文档的时间戳；对少量文件来说这已经足够，
// 也避免了为每个标签页各开一个等待句柄。

CRITICAL_SECTION g_watchLock;
bool g_watchLockReady = false;
HANDLE g_watchThread = nullptr;
LONG g_watchStop = 0;

struct WatchedFile {
    std::wstring path;
    ULONGLONG stamp;
};

std::vector<WatchedFile> g_watchList;

/** 最后写入时间；文件已不存在时返回 0。 */
ULONGLONG FileStamp(const std::wstring& path)
{
    WIN32_FILE_ATTRIBUTE_DATA data;
    if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &data)) { return 0; }
    ULONGLONG stamp = (static_cast<ULONGLONG>(data.ftLastWriteTime.dwHighDateTime) << 32) |
                       data.ftLastWriteTime.dwLowDateTime;
    return stamp ? stamp : 1;
}

DWORD WINAPI WatchThreadProc(LPVOID)
{
    for (;;) {
        if (InterlockedCompareExchange(&g_watchStop, 1, 1) == 1) { break; }
        Sleep(500);

        std::vector<std::pair<std::wstring, bool> > changes;
        EnterCriticalSection(&g_watchLock);
        for (size_t i = 0; i < g_watchList.size(); ++i) {
            ULONGLONG stamp = FileStamp(g_watchList[i].path);
            if (stamp != g_watchList[i].stamp) {
                changes.push_back(std::make_pair(g_watchList[i].path, stamp != 0));
                g_watchList[i].stamp = stamp;
            }
        }
        LeaveCriticalSection(&g_watchLock);

        for (size_t i = 0; i < changes.size(); ++i) {
            Json payload = Json::Object();
            payload.Set("event", Json::Str("fileChanged"));
            payload.Set("path", Json::Str(WideToUtf8(changes[i].first)));
            payload.Set("removed", Json::Bool(!changes[i].second));
            PostEventFromAnyThread(payload.Dump());
        }
    }
    return 0;
}

void UpdateWatchList(const std::vector<std::wstring>& paths)
{
    if (!g_watchLockReady) {
        InitializeCriticalSection(&g_watchLock);
        g_watchLockReady = true;
    }
    if (!g_watchThread) {
        g_watchThread = CreateThread(nullptr, 0, WatchThreadProc, nullptr, 0, nullptr);
    }

    EnterCriticalSection(&g_watchLock);
    std::vector<WatchedFile> next;
    for (size_t i = 0; i < paths.size(); ++i) {
        WatchedFile entry;
        entry.path = paths[i];
        entry.stamp = FileStamp(paths[i]);
        for (size_t j = 0; j < g_watchList.size(); ++j) {
            if (CompareNoCase(g_watchList[j].path, paths[i]) == 0) {
                entry.stamp = g_watchList[j].stamp;
                break;
            }
        }
        next.push_back(entry);
    }
    g_watchList.swap(next);
    LeaveCriticalSection(&g_watchLock);
}

/** 编辑器写入文件后调用，以免把自己的保存当作外部改动回报给用户。 */
void RefreshWatchStamp(const std::wstring& path)
{
    if (!g_watchLockReady || path.empty()) { return; }
    EnterCriticalSection(&g_watchLock);
    for (size_t i = 0; i < g_watchList.size(); ++i) {
        if (CompareNoCase(g_watchList[i].path, path) == 0) {
            g_watchList[i].stamp = FileStamp(path);
            break;
        }
    }
    LeaveCriticalSection(&g_watchLock);
}

bool IsSafeFileName(const std::wstring& name)
{
    if (name.empty() || name == L"." || name == L"..") { return false; }
    if (name.find_first_of(L"\\/:*?\"<>|") != std::wstring::npos) { return false; }
    return name.back() != L'.' && name.back() != L' ';
}

// -------------------------------------------------------------- 剪贴板
//
// 浏览器只有在窗口持有焦点时才能写入剪贴板，原生剪贴板没有这个限制，因此
// “复制为富文本”走 Win32，同时携带 HTML（CF_HTML）以及纯文本和 RTF 两种
// 备选——正是 Word、Outlook 和普通编辑器各自会寻找的三种格式。

std::string BuildHtmlClipboard(const std::string& fragment)
{
    // 定宽偏移量：下面写出的头部长度与用于计算偏移的占位内容完全一致。
    const std::string head = "<html><body>\r\n<!--StartFragment-->";
    const std::string tail = "<!--EndFragment-->\r\n</body></html>";
    const size_t headerLength = 102;

    size_t startHtml = headerLength;
    size_t startFragment = startHtml + head.size();
    size_t endFragment = startFragment + fragment.size();
    size_t endHtml = endFragment + tail.size();

    std::string header = "Version:0.9\r\nStartHTML:";
    AppendNumber(header, startHtml, 10, 10, false);
    header += "\r\nEndHTML:";
    AppendNumber(header, endHtml, 10, 10, false);
    header += "\r\nStartFragment:";
    AppendNumber(header, startFragment, 10, 10, false);
    header += "\r\nEndFragment:";
    AppendNumber(header, endFragment, 10, 10, false);
    header += "\r\n";

    return header + head + fragment + tail;
}

bool PutClipboardBlock(UINT format, const void* data, size_t bytes)
{
    if (!format || !data || !bytes) { return false; }
    HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, bytes);
    if (!memory) { return false; }

    void* target = GlobalLock(memory);
    if (!target) { GlobalFree(memory); return false; }
    memcpy(target, data, bytes);
    GlobalUnlock(memory);

    if (!SetClipboardData(format, memory)) {
        GlobalFree(memory);
        return false;
    }
    return true;
}

bool CopyRichTextToClipboard(const std::string& htmlFragment, const std::string& text,
                             const std::string& rtf)
{
    std::wstring wideText = Utf8ToWide(text);
    std::string html = BuildHtmlClipboard(htmlFragment);
    UINT cfHtml = RegisterClipboardFormatW(L"HTML Format");
    UINT cfRtf = RegisterClipboardFormatW(L"Rich Text Format");

    if (!OpenClipboard(g_host.window)) { return false; }
    EmptyClipboard();

    bool ok = PutClipboardBlock(CF_UNICODETEXT, wideText.c_str(),
                                (wideText.size() + 1) * sizeof(wchar_t));
    ok = PutClipboardBlock(cfHtml, html.data(), html.size()) || ok;
    if (!rtf.empty()) { ok = PutClipboardBlock(cfRtf, rtf.data(), rtf.size()) || ok; }

    CloseClipboard();
    return ok;
}

// -------------------------------------------------------------- 导出 PDF
class PrintHandler : public ICoreWebView2PrintToPdfCompletedHandler {
public:
    PrintHandler(long long id, const std::wstring& path) : id_(id), path_(path), ref_(1) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override
    {
        if (!ppv) { return E_POINTER; }
        if (IsEqualIID(riid, IID_IUnknown) ||
            IsEqualIID(riid, __uuidof(ICoreWebView2PrintToPdfCompletedHandler))) {
            *ppv = static_cast<ICoreWebView2PrintToPdfCompletedHandler*>(this);
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

    HRESULT STDMETHODCALLTYPE Invoke(HRESULT errorCode, BOOL isSuccessful) override
    {
        if (FAILED(errorCode) || !isSuccessful) {
            PostReply(id_, Json(), "导出 PDF 失败");
        } else {
            Json payload = Json::Object();
            payload.Set("path", Json::Str(WideToUtf8(path_)));
            payload.Set("name", Json::Str(WideToUtf8(FileNameOf(path_))));
            PostReply(id_, payload, "");
        }
        return S_OK;
    }

private:
    long long id_;
    std::wstring path_;
    LONG ref_;
};

}  // namespace

// ------------------------------------------------------------------ WebView
ICoreWebView2* HostWebView();

// ----------------------------------------------------------------- 分发
CommandResult HandleCommand(const std::string& command, const Json& data, long long id)
{
    CommandResult result;

    if (command == "ready") {
        LogLine("boot: page ready " + Ms());
        Json payload = Json::Object();
        payload.Set("config", g_host.config);
        payload.Set("portable", Json::Bool(g_host.portableData));
        payload.Set("dataDir", Json::Str(WideToUtf8(g_host.dataDir)));
        payload.Set("version", Json::Str("0.1"));
        payload.Set("args", g_host.startupFile.empty()
            ? Json() : Json::Str(WideToUtf8(g_host.startupFile)));
        payload.Set("maximized", Json::Bool(g_host.maximizeOnStart));
        // 窗口框架先于页面绘制，因此要把绘制所用的颜色告知页面。
        payload.Set("frameColor", Json::Str(FrameColorHex()));
        result.payload = payload;
        return result;
    }

    if (command == "log") {
        LogLine(data.StringOr("line", ""));
        return result;
    }

    if (command == "openPath" || command == "openDialog") {
        std::wstring path;
        if (command == "openDialog") {
            path = OpenFileDialog(g_host.window, g_host.lastFolder);
            if (path.empty()) {
                Json payload = Json::Object();
                payload.Set("canceled", Json::Bool(true));
                result.payload = payload;
                return result;
            }
        } else {
            path = Utf8ToWide(data.StringOr("path", ""));
        }

        std::vector<unsigned char> bytes;
        if (path.empty() || !ReadFileBytes(path, &bytes)) {
            result.error = "文件不存在";
            return result;
        }

        UINT codePage = CP_UTF8;
        std::string text = DecodeText(bytes, &codePage);
        g_host.encodings[path] = codePage;
        g_host.lastFolder = DirectoryOf(path);
        g_host.config.Set("lastFolder", Json::Str(WideToUtf8(g_host.lastFolder)));
        g_host.docDir = g_host.lastFolder;
        SaveConfig();

        result.payload = FilePayload(path, text, codePage, bytes.size());
        return result;
    }

    if (command == "save" || command == "saveAs") {
        std::wstring path = Utf8ToWide(data.StringOr("path", ""));
        std::string text = data.StringOr("text", "");

        if (command == "saveAs" || path.empty()) {
            std::wstring suggested = Utf8ToWide(data.StringOr("suggested", "未命名.md"));
            path = SaveFileDialog(g_host.window, EnsureMarkdownExtension(suggested),
                                  L"*.md;*.markdown;*.mdown;*.mkd;*.txt");
            if (path.empty()) {
                Json payload = Json::Object();
                payload.Set("canceled", Json::Bool(true));
                result.payload = payload;
                return result;
            }
        }

        UINT codePage = CP_UTF8;
        auto found = g_host.encodings.find(path);
        if (found != g_host.encodings.end()) { codePage = found->second; }

        if (!WriteFileText(path, text, codePage)) {
            result.error = "写入失败";
            return result;
        }
        RefreshWatchStamp(path);

        g_host.lastFolder = DirectoryOf(path);
        g_host.config.Set("lastFolder", Json::Str(WideToUtf8(g_host.lastFolder)));
        g_host.docDir = g_host.lastFolder;
        SaveConfig();

        Json payload = Json::Object();
        payload.Set("path", Json::Str(WideToUtf8(path)));
        payload.Set("name", Json::Str(WideToUtf8(FileNameOf(path))));
        payload.Set("dir", Json::Str(WideToUtf8(DirectoryOf(path))));
        result.payload = payload;
        return result;
    }

    if (command == "exportHtml") {
        std::wstring path = Utf8ToWide(data.StringOr("path", ""));
        if (path.empty()) {
            std::wstring suggested = Utf8ToWide(data.StringOr("suggested", "未命名.html"));
            path = SaveFileDialog(g_host.window, suggested, L"*.html");
            if (path.empty()) {
                Json payload = Json::Object();
                payload.Set("canceled", Json::Bool(true));
                result.payload = payload;
                return result;
            }
        }
        if (!WriteFileText(path, data.StringOr("html", ""), CP_UTF8)) {
            result.error = "写入失败";
            return result;
        }
        Json payload = Json::Object();
        payload.Set("path", Json::Str(WideToUtf8(path)));
        payload.Set("name", Json::Str(WideToUtf8(FileNameOf(path))));
        result.payload = payload;
        return result;
    }

    if (command == "exportPdf") {
        std::wstring path = Utf8ToWide(data.StringOr("path", ""));
        if (path.empty()) {
            std::wstring suggested = Utf8ToWide(data.StringOr("suggested", "未命名.pdf"));
            path = SaveFileDialog(g_host.window, suggested, L"*.pdf");
            if (path.empty()) {
                Json payload = Json::Object();
                payload.Set("canceled", Json::Bool(true));
                result.payload = payload;
                return result;
            }
        }

        ICoreWebView2* webview = HostWebView();
        if (!webview) {
            result.error = "导出 PDF 失败";
            return result;
        }

        ComPtr<ICoreWebView2_7> modern;
        if (FAILED(webview->QueryInterface(__uuidof(ICoreWebView2_7),
                                           reinterpret_cast<void**>(modern.Put())))) {
            result.error = "导出 PDF 失败";
            return result;
        }

        ICoreWebView2Environment* environment = HostEnvironment();
        ComPtr<ICoreWebView2Environment6> environment6;
        ComPtr<ICoreWebView2PrintSettings> settings;
        if (!environment ||
            FAILED(environment->QueryInterface(__uuidof(ICoreWebView2Environment6),
                                               reinterpret_cast<void**>(environment6.Put()))) ||
            FAILED(environment6->CreatePrintSettings(settings.Put())) || !settings) {
            result.error = "导出 PDF 失败";
            return result;
        }
        settings->put_ShouldPrintBackgrounds(TRUE);
        settings->put_ShouldPrintHeaderAndFooter(FALSE);
        settings->put_MarginTop(0.55);
        settings->put_MarginBottom(0.55);
        settings->put_MarginLeft(0.6);
        settings->put_MarginRight(0.6);

        auto* handler = new PrintHandler(id, path);
        if (FAILED(modern->PrintToPdf(path.c_str(), settings.Get(), handler))) {
            handler->Release();
            result.error = "导出 PDF 失败";
            return result;
        }
        handler->Release();
        result.deferred = true;
        return result;
    }

    if (command == "savePastedImage") {
        std::string encoded = data.StringOr("base64", "");
        std::string extension = ToLowerAscii(data.StringOr("extension", "png"));
        std::wstring docPath = Utf8ToWide(data.StringOr("docPath", ""));

        if (extension != "png" && extension != "jpg" && extension != "jpeg" &&
            extension != "gif" && extension != "webp" && extension != "bmp" &&
            extension != "svg") {
            extension = "png";
        }

        std::wstring folder = DirectoryOf(docPath);
        if (folder.empty()) {
            result.error = "请先保存文档，图片会存放到文档同级目录";
            return result;
        }

        std::vector<unsigned char> bytes;
        if (!Base64Decode(encoded, &bytes) || bytes.empty()) {
            result.error = "图片数据为空";
            return result;
        }

        SYSTEMTIME now;
        GetLocalTime(&now);
        std::string name = "image-";
        AppendNumber(name, now.wYear, 10, 4, false);
        AppendNumber(name, now.wMonth, 10, 2, false);
        AppendNumber(name, now.wDay, 10, 2, false);
        name += '-';
        AppendNumber(name, now.wHour, 10, 2, false);
        AppendNumber(name, now.wMinute, 10, 2, false);
        AppendNumber(name, now.wSecond, 10, 2, false);
        name += '-';
        AppendNumber(name, static_cast<unsigned>(rand() % 9000 + 1000), 10, 0, false);
        name += '.';
        name += extension;

        std::wstring assets = JoinPath(folder, L"assets");
        CreateDirectoryW(assets.c_str(), nullptr);
        std::wstring full = JoinPath(assets, Utf8ToWide(name));

        HANDLE file = CreateFileW(full.c_str(), GENERIC_WRITE, 0, nullptr,
                                  CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file == INVALID_HANDLE_VALUE) {
            result.error = "保存图片失败";
            return result;
        }
        DWORD written = 0;
        WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr);
        CloseHandle(file);

        Json payload = Json::Object();
        payload.Set("relative", Json::Str("assets/" + std::string(name)));
        payload.Set("absolute", Json::Str(WideToUtf8(full)));
        result.payload = payload;
        return result;
    }

    if (command == "pickFolder") {
        std::wstring current = Utf8ToWide(data.StringOr("current", ""));
        std::wstring path = PickFolderDialog(g_host.window, current.empty() ? g_host.lastFolder : current);
        if (path.empty()) {
            Json payload = Json::Object();
            payload.Set("canceled", Json::Bool(true));
            result.payload = payload;
            return result;
        }
        g_host.lastFolder = path;
        g_host.config.Set("lastFolder", Json::Str(WideToUtf8(path)));
        SaveConfig();
        Json payload = Json::Object();
        payload.Set("path", Json::Str(WideToUtf8(path)));
        result.payload = payload;
        return result;
    }

    if (command == "listDir") {
        std::wstring path = Utf8ToWide(data.StringOr("path", ""));
        result.payload = DirectoryListing(path);
        return result;
    }

    if (command == "searchFiles") {
        std::wstring root = Utf8ToWide(data.StringOr("root", ""));
        std::wstring query = Utf8ToWide(data.StringOr("query", ""));
        Json matches = Json::Array();
        int budget = 300;
        if (!root.empty() && !query.empty()) {
            SearchFilesInto(root, query, 0, &budget, &matches);
        }
        Json payload = Json::Object();
        payload.Set("matches", matches);
        payload.Set("truncated", Json::Bool(budget <= 0));
        result.payload = payload;
        return result;
    }

    if (command == "reveal") {
        std::wstring path = Utf8ToWide(data.StringOr("path", ""));
        if (!path.empty()) {
            std::wstring args = L"/select,\"" + path + L"\"";
            ShellExecuteW(nullptr, L"open", L"explorer.exe", args.c_str(), nullptr, SW_SHOWNORMAL);
        }
        return result;
    }

    if (command == "openExternal") {
        std::wstring url = Utf8ToWide(data.StringOr("url", ""));
        if (!url.empty()) {
            ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
        }
        return result;
    }

    if (command == "window") {
        std::string action = data.StringOr("action", "");
        if (action == "minimize") {
            ShowWindow(g_host.window, SW_MINIMIZE);
        } else if (action == "maximize") {
            ShowWindow(g_host.window, IsZoomed(g_host.window) ? SW_RESTORE : SW_MAXIMIZE);
        } else if (action == "close") {
            g_host.allowClose = true;
            PostMessageW(g_host.window, WM_CLOSE, 0, 0);
        } else if (action == "activate") {
            // 剪贴板 API 只有在窗口持有焦点时才会响应；
            // 任何把窗口带到前台的操作都要做同样的处理。
            if (IsIconic(g_host.window)) { ShowWindow(g_host.window, SW_RESTORE); }
            SetForegroundWindow(g_host.window);
            FocusWebContent();
        } else if (action == "topmost") {
            // 窗口置顶。调用方发送的是它想要的状态，因此重复执行该命令不会把
            // 窗口来回切换两次；什么都不发的调用方仍得到旧的切换行为。该标志
            // 保存在窗口的扩展样式中，所以回复给出的是实际生效的结果，
            // 而不是请求的值。
            const Json* want = data.Find("on");
            bool on = want
                ? want->AsBool()
                : (GetWindowLongPtrW(g_host.window, GWL_EXSTYLE) & WS_EX_TOPMOST) == 0;
            BOOL moved = SetWindowPos(g_host.window, on ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0,
                                      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            LogLine("want=" + std::string(on ? "on" : "off") + " set=" + std::to_string(moved) +
                    " now=" + std::to_string((GetWindowLongPtrW(g_host.window, GWL_EXSTYLE) &
                                              WS_EX_TOPMOST) != 0) +
                    " visible=" + std::to_string(IsWindowVisible(g_host.window) != 0) +
                    " iconic=" + std::to_string(IsIconic(g_host.window) != 0) +
                    " err=" + std::to_string(GetLastError()));
        }
        Json payload = Json::Object();
        payload.Set("maximized", Json::Bool(IsZoomed(g_host.window) != 0));
        payload.Set("topmost",
            Json::Bool((GetWindowLongPtrW(g_host.window, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0));
        result.payload = payload;
        return result;
    }

    if (command == "drag") {
        ReleaseCapture();
        SendMessageW(g_host.window, WM_NCLBUTTONDOWN, HTCAPTION, 0);
        return result;
    }

    if (command == "maximizeHover") {
        g_host.maximizeHover = data.BoolOr("hover", false);
        return result;
    }

    if (command == "title") {
        SetWindowTextW(g_host.window, Utf8ToWide(data.StringOr("text", "cNote")).c_str());
        return result;
    }

    if (command == "background") {
        g_host.config.Set("background", Json::Str(data.StringOr("color", "#F7F5F0")));
        ApplyWindowBackground();
        ApplyBackgroundColor();
        return result;
    }

    if (command == "frameColor") {
        Json payload = Json::Object();
        payload.Set("color", Json::Str(FrameColorHex()));
        result.payload = payload;
        return result;
    }

    if (command == "config") {
        const Json* incoming = data.Find("config");
        if (incoming && incoming->IsObject()) {
            // 窗口位置归宿主管理，因此自己保留一份副本。
            Json windowPlacement = g_host.config.Find("window")
                ? *g_host.config.Find("window") : Json::Object();
            for (const auto& entry : incoming->members()) {
                g_host.config.Set(entry.first, entry.second);
            }
            g_host.config.Set("window", windowPlacement);
            SaveConfig();
        }
        return result;
    }

    if (command == "setDocDirectory") {
        std::wstring path = Utf8ToWide(data.StringOr("path", ""));
        g_host.docDir = path.empty() ? std::wstring() : DirectoryOf(path);
        return result;
    }

    if (command == "watch") {
        std::vector<std::wstring> paths;
        const Json* list = data.Find("paths");
        if (list && list->IsArray()) {
            for (size_t i = 0; i < list->items().size(); ++i) {
                if (list->items()[i].IsString()) { paths.push_back(Utf8ToWide(list->items()[i].AsString())); }
            }
        }
        UpdateWatchList(paths);
        return result;
    }

    if (command == "print") {
        ICoreWebView2* webview = HostWebView();
        ComPtr<ICoreWebView2_16> modern;
        bool supported = webview &&
            SUCCEEDED(webview->QueryInterface(__uuidof(ICoreWebView2_16),
                                              reinterpret_cast<void**>(modern.Put()))) &&
            modern;

        // 在不打开对话框的情况下探测该能力是否可用。
        if (data.BoolOr("dryRun", false)) {
            Json payload = Json::Object();
            payload.Set("supported", Json::Bool(supported));
            result.payload = payload;
            return result;
        }

        if (supported && SUCCEEDED(modern->ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER))) {
            Json payload = Json::Object();
            payload.Set("printed", Json::Bool(true));
            result.payload = payload;
            return result;
        }
        result.error = "当前 WebView2 运行时不支持打印对话框";
        return result;
    }

    // 所有“把这段内容保存到某处”的操作共用一个写出函数：文本导出、
    // base64 数据（RTF、PNG）以及长图截取都要经过它。
    if (command == "exportFile") {
        std::wstring path = Utf8ToWide(data.StringOr("path", ""));
        if (path.empty()) {
            std::wstring suggested = Utf8ToWide(data.StringOr("suggested", "未命名.txt"));
            std::wstring filter = Utf8ToWide(data.StringOr("filter", "*.*"));
            path = SaveFileDialog(g_host.window, suggested, filter.c_str());
            if (path.empty()) {
                Json payload = Json::Object();
                payload.Set("canceled", Json::Bool(true));
                result.payload = payload;
                return result;
            }
        }

        std::string base64 = data.StringOr("base64", "");
        bool ok = false;
        if (!base64.empty()) {
            std::vector<unsigned char> bytes;
            if (!Base64Decode(base64, &bytes) || bytes.empty()) {
                result.error = "内容为空";
                return result;
            }
            ok = WriteFileBytes(path, bytes);
        } else {
            ok = WriteFileText(path, data.StringOr("text", ""), CP_UTF8);
        }

        if (!ok) {
            result.error = "写入失败";
            return result;
        }
        RefreshWatchStamp(path);

        Json payload = Json::Object();
        payload.Set("path", Json::Str(WideToUtf8(path)));
        payload.Set("name", Json::Str(WideToUtf8(FileNameOf(path))));
        result.payload = payload;
        return result;
    }

    if (command == "copyRich") {
        // Chrome 只在获得焦点时才写入剪贴板，Win32 则不然，因此富文本复制
        // 由原生代码完成，同时提供 HTML + 文本 + RTF 三种格式。
        Json payload = Json::Object();
        bool copied = CopyRichTextToClipboard(data.StringOr("html", ""),
                                              data.StringOr("text", ""),
                                              data.StringOr("rtf", ""));
        payload.Set("copied", Json::Bool(copied));
        result.payload = payload;
        return result;
    }

    if (command == "readClipboard") {
        // 回读的存在是为了让调用方能够证明剪贴板中确实存有富文本，
        // 而不是仅凭一个返回码就相信。
        Json payload = Json::Object();
        if (OpenClipboard(g_host.window)) {
            HANDLE textHandle = GetClipboardData(CF_UNICODETEXT);
            if (textHandle) {
                const wchar_t* raw = static_cast<const wchar_t*>(GlobalLock(textHandle));
                if (raw) {
                    payload.Set("text", Json::Str(WideToUtf8(raw)));
                    GlobalUnlock(textHandle);
                }
            }
            UINT cfHtml = RegisterClipboardFormatW(L"HTML Format");
            if (cfHtml) {
                HANDLE htmlHandle = GetClipboardData(cfHtml);
                if (htmlHandle) {
                    const char* raw = static_cast<const char*>(GlobalLock(htmlHandle));
                    if (raw) {
                        payload.Set("html", Json::Str(std::string(raw)));
                        GlobalUnlock(htmlHandle);
                    }
                }
            }
            CloseClipboard();
        }
        payload.Set("hasHtml", Json::Bool(payload.Find("html") != nullptr));
        result.payload = payload;
        return result;
    }

    if (command == "readText") {
        std::wstring path = Utf8ToWide(data.StringOr("path", ""));
        std::vector<unsigned char> bytes;
        if (path.empty() || !ReadFileBytes(path, &bytes)) {
            Json payload = Json::Object();
            payload.Set("missing", Json::Bool(true));
            result.payload = payload;
            return result;
        }
        UINT codePage = CP_UTF8;
        std::string text = DecodeText(bytes, &codePage);
        Json payload = Json::Object();
        payload.Set("path", Json::Str(WideToUtf8(path)));
        payload.Set("text", Json::Str(text));
        payload.Set("encoding", Json::Str(EncodingName(codePage)));
        result.payload = payload;
        return result;
    }

    if (command == "fsNew") {
        std::wstring dir = Utf8ToWide(data.StringOr("dir", ""));
        std::wstring name = Utf8ToWide(data.StringOr("name", ""));
        bool folder = data.BoolOr("folder", false);
        if (dir.empty() || !IsSafeFileName(name)) {
            result.error = "文件名无效";
            return result;
        }
        if (!folder) { name = EnsureMarkdownExtension(name); }

        std::wstring full = JoinPath(dir, name);
        if (GetFileAttributesW(full.c_str()) != INVALID_FILE_ATTRIBUTES) {
            result.error = "同名文件已存在";
            return result;
        }

        if (folder) {
            if (!CreateDirectoryW(full.c_str(), nullptr)) {
                result.error = "创建文件夹失败";
                return result;
            }
        } else if (!WriteFileText(full, "", CP_UTF8)) {
            result.error = "创建文件失败";
            return result;
        }

        Json payload = Json::Object();
        payload.Set("path", Json::Str(WideToUtf8(full)));
        payload.Set("name", Json::Str(WideToUtf8(name)));
        payload.Set("dir", Json::Bool(folder));
        result.payload = payload;
        return result;
    }

    if (command == "fsRename") {
        std::wstring path = Utf8ToWide(data.StringOr("path", ""));
        std::wstring name = Utf8ToWide(data.StringOr("name", ""));
        if (path.empty() || !IsSafeFileName(name)) {
            result.error = "文件名无效";
            return result;
        }

        bool folder = (GetFileAttributesW(path.c_str()) & FILE_ATTRIBUTE_DIRECTORY) != 0;
        if (!folder) { name = EnsureMarkdownExtension(name); }
        std::wstring full = JoinPath(DirectoryOf(path), name);
        if (CompareNoCase(full, path) != 0) {
            if (GetFileAttributesW(full.c_str()) != INVALID_FILE_ATTRIBUTES) {
                result.error = "同名文件已存在";
                return result;
            }
            if (!MoveFileW(path.c_str(), full.c_str())) {
                result.error = "重命名失败";
                return result;
            }
        }

        Json payload = Json::Object();
        payload.Set("path", Json::Str(WideToUtf8(full)));
        payload.Set("from", Json::Str(WideToUtf8(path)));
        payload.Set("name", Json::Str(WideToUtf8(name)));
        result.payload = payload;
        return result;
    }

    if (command == "fsDelete") {
        std::wstring path = Utf8ToWide(data.StringOr("path", ""));
        if (path.empty() || GetFileAttributesW(path.c_str()) == INVALID_FILE_ATTRIBUTES) {
            result.error = "文件不存在";
            return result;
        }

        // 移入回收站而非彻底删除：误操作必须可以撤销。
        std::vector<wchar_t> from(path.begin(), path.end());
        from.push_back(L'\0');
        from.push_back(L'\0');

        SHFILEOPSTRUCTW operation = {};
        operation.wFunc = FO_DELETE;
        operation.pFrom = from.data();
        operation.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI;
        int status = SHFileOperationW(&operation);
        if (status != 0 || operation.fAnyOperationsAborted) {
            result.error = "删除失败";
            return result;
        }

        Json payload = Json::Object();
        payload.Set("path", Json::Str(WideToUtf8(path)));
        payload.Set("deleted", Json::Bool(true));
        result.payload = payload;
        return result;
    }

    if (command == "downloadUrl") {
        std::wstring url = Utf8ToWide(data.StringOr("url", ""));
        std::wstring dir = Utf8ToWide(data.StringOr("dir", ""));
        std::wstring name = Utf8ToWide(data.StringOr("name", ""));
        // 网络用 http/https，file:// 则让本地图片也能经同一条路径复制进来
        // （也便于在没有网络的情况下测试）。
        bool schemeOk = url.compare(0, 5, L"http:") == 0 ||
                        url.compare(0, 6, L"https:") == 0 ||
                        url.compare(0, 5, L"file:") == 0;
        if (!schemeOk || dir.empty()) {
            result.error = "下载地址无效";
            return result;
        }
        if (!IsSafeFileName(name)) {
            name = L"image.png";
        }

        std::wstring full = JoinPath(dir, L"assets\\" + name);
        CreateDirectoryW(JoinPath(dir, L"assets").c_str(), nullptr);

        HRESULT hr = URLDownloadToFileW(nullptr, url.c_str(), full.c_str(), 0, nullptr);
        if (FAILED(hr)) {
            result.error = "下载图片失败";
            return result;
        }

        Json payload = Json::Object();
        payload.Set("path", Json::Str(WideToUtf8(full)));
        payload.Set("relative", Json::Str("assets/" + WideToUtf8(name)));
        result.payload = payload;
        return result;
    }

    result.error = "未知命令: " + command;
    return result;
}
