// 为配置文件和桥接协议实现的最小 JSON。
#include "mn.h"

#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <cstring>

// ------------------------------------------------------------------ 构造
Json Json::Bool(bool v) { Json j; j.type_ = Type::Bool; j.bool_ = v; return j; }
Json Json::Number(double v) { Json j; j.type_ = Type::Number; j.number_ = v; return j; }
Json Json::Str(const std::string& v) { Json j; j.type_ = Type::String; j.string_ = v; return j; }
Json Json::Array() { Json j; j.type_ = Type::Array; return j; }
Json Json::Object() { Json j; j.type_ = Type::Object; return j; }

// ------------------------------------------------------------------ 访问
Json* Json::Find(const std::string& key)
{
    if (type_ != Type::Object) { return nullptr; }
    for (auto& entry : members_) {
        if (entry.first == key) { return &entry.second; }
    }
    return nullptr;
}

const Json* Json::Find(const std::string& key) const
{
    return const_cast<Json*>(this)->Find(key);
}

void Json::Set(const std::string& key, const Json& value)
{
    if (type_ != Type::Object) { type_ = Type::Object; }
    for (auto& entry : members_) {
        if (entry.first == key) { entry.second = value; return; }
    }
    members_.emplace_back(key, value);
}

double Json::NumberOr(const std::string& key, double fallback) const
{
    const Json* found = Find(key);
    return found ? found->AsNumber(fallback) : fallback;
}

bool Json::BoolOr(const std::string& key, bool fallback) const
{
    const Json* found = Find(key);
    return found ? found->AsBool(fallback) : fallback;
}

std::string Json::StringOr(const std::string& key, const std::string& fallback) const
{
    const Json* found = Find(key);
    return found ? found->StringOr(fallback) : fallback;
}

// -------------------------------------------------------------------- 写出
static void AppendUtf8(std::string& out, unsigned int code)
{
    if (code < 0x80) {
        out += static_cast<char>(code);
    } else if (code < 0x800) {
        out += static_cast<char>(0xC0 | (code >> 6));
        out += static_cast<char>(0x80 | (code & 0x3F));
    } else if (code < 0x10000) {
        out += static_cast<char>(0xE0 | (code >> 12));
        out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (code & 0x3F));
    } else {
        out += static_cast<char>(0xF0 | (code >> 18));
        out += static_cast<char>(0x80 | ((code >> 12) & 0x3F));
        out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (code & 0x3F));
    }
}

static void WriteString(std::string& out, const std::string& text)
{
    out += '"';
    for (unsigned char ch : text) {
        switch (ch) {
        case '"':  out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        default:
            if (ch < 0x20) {
                out += "\\u";
                AppendNumber(out, ch, 16, 4, false);
            } else {
                // UTF-8 原样通过，这样中文保持可读。
                out += static_cast<char>(ch);
            }
        }
    }
    out += '"';
}

static void WriteNumber(std::string& out, double value)
{
    if (value == static_cast<double>(static_cast<long long>(value)) &&
        std::fabs(value) < 1e15) {
        AppendSigned(out, static_cast<long long>(value), 0);
        return;
    }

    // 手工写出通用格式下的六位有效数字——也就是 %.6g 的输出。实测：%.6g 会
    // 引入约 8 KB 的浮点 printf，而 std::to_chars 引入的更多（它带进 Ryu）。
    // 配置里只存放比例和尺寸，六位数字已完全够用。
    bool negative = value < 0;
    if (negative) { value = -value; }

    // 规格化为 d.ddddd 并记下 10 的幂次。
    int exponent = 0;
    while (value >= 10) { value /= 10; exponent++; }
    while (value < 1) { value *= 10; exponent--; }

    // 把六位有效数字表示为 [100000, 1000000) 区间内的整数，四舍五入，
    // 若进位溢出则向指数进位（9.999999 -> 10.0000）。
    long long digits = static_cast<long long>(value * 100000 + 0.5);
    if (digits >= 1000000) { digits /= 10; exponent++; }

    if (negative) { out += '-'; }

    if (exponent < -4 || exponent >= 6) {
        // 指数写法 d.ddddde+xx
        const std::string mantissa = std::to_string(digits);
        std::string text = mantissa.substr(0, 1) + "." + mantissa.substr(1);
        while (text.back() == '0') { text.pop_back(); }
        if (text.back() == '.') { text.pop_back(); }
        const int magnitude = exponent < 0 ? -exponent : exponent;
        text += 'e';
        text += exponent < 0 ? '-' : '+';
        if (magnitude < 10) { text += '0'; }
        text += std::to_string(magnitude);
        out += text;
        return;
    }

    std::string text = std::to_string(digits);
    if (exponent >= 0) {
        // 小数点位于前 exponent+1 位数字之后。
        text.insert(static_cast<size_t>(exponent) + 1, 1, '.');
    } else {
        text = "0." + std::string(static_cast<size_t>(-exponent) - 1, '0') + text;
    }
    while (text.back() == '0') { text.pop_back(); }
    if (text.back() == '.') { text.pop_back(); }
    out += text;
}

static void WriteValue(std::string& out, const Json& value, int indent, int depth)
{
    const std::string pad(indent * (depth + 1), ' ');
    const std::string padEnd(indent * depth, ' ');

    switch (value.type()) {
    case Json::Type::Null: out += "null"; break;
    case Json::Type::Bool: out += value.AsBool() ? "true" : "false"; break;
    case Json::Type::Number: WriteNumber(out, value.AsNumber()); break;
    case Json::Type::String: WriteString(out, value.AsString()); break;

    case Json::Type::Array: {
        if (value.items().empty()) { out += "[]"; break; }
        out += '[';
        for (size_t i = 0; i < value.items().size(); ++i) {
            if (i) { out += ','; }
            if (indent) { out += '\n'; out += pad; }
            WriteValue(out, value.items()[i], indent, depth + 1);
        }
        if (indent) { out += '\n'; out += padEnd; }
        out += ']';
        break;
    }

    case Json::Type::Object: {
        if (value.members().empty()) { out += "{}"; break; }
        out += '{';
        for (size_t i = 0; i < value.members().size(); ++i) {
            if (i) { out += ','; }
            if (indent) { out += '\n'; out += pad; }
            WriteString(out, value.members()[i].first);
            out += indent ? ": " : ":";
            WriteValue(out, value.members()[i].second, indent, depth + 1);
        }
        if (indent) { out += '\n'; out += padEnd; }
        out += '}';
        break;
    }
    }
}

std::string Json::Dump() const
{
    std::string out;
    WriteValue(out, *this, 0, 0);
    return out;
}

std::string DumpPretty(const Json& value, int indent)
{
    std::string out;
    WriteValue(out, value, indent, 0);
    return out;
}

// -------------------------------------------------------------------- 解析
namespace {

struct Parser {
    const char* p;
    const char* end;
    bool ok;

    void Skip()
    {
        while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) { ++p; }
    }

    bool Literal(const char* text)
    {
        size_t n = strlen(text);
        if (static_cast<size_t>(end - p) < n || strncmp(p, text, n) != 0) { return false; }
        p += n;
        return true;
    }

    std::string ParseString()
    {
        std::string out;
        if (p >= end || *p != '"') { ok = false; return out; }
        ++p;
        while (p < end) {
            unsigned char ch = static_cast<unsigned char>(*p++);
            if (ch == '"') { return out; }
            if (ch != '\\') { out += static_cast<char>(ch); continue; }
            if (p >= end) { break; }
            char esc = *p++;
            switch (esc) {
            case '"':  out += '"'; break;
            case '\\': out += '\\'; break;
            case '/':  out += '/'; break;
            case 'b':  out += '\b'; break;
            case 'f':  out += '\f'; break;
            case 'n':  out += '\n'; break;
            case 'r':  out += '\r'; break;
            case 't':  out += '\t'; break;
            case 'u': {
                unsigned int code = 0;
                for (int i = 0; i < 4 && p < end; ++i) {
                    char hex = *p++;
                    code <<= 4;
                    if (hex >= '0' && hex <= '9') { code |= static_cast<unsigned>(hex - '0'); }
                    else if (hex >= 'a' && hex <= 'f') { code |= static_cast<unsigned>(hex - 'a' + 10); }
                    else if (hex >= 'A' && hex <= 'F') { code |= static_cast<unsigned>(hex - 'A' + 10); }
                    else { ok = false; return out; }
                }
                // 代理对 -> 单个码点。
                if (code >= 0xD800 && code <= 0xDBFF && end - p >= 6 && p[0] == '\\' && p[1] == 'u') {
                    unsigned int low = 0;
                    const char* save = p;
                    p += 2;
                    bool valid = true;
                    for (int i = 0; i < 4 && p < end; ++i) {
                        char hex = *p++;
                        low <<= 4;
                        if (hex >= '0' && hex <= '9') { low |= static_cast<unsigned>(hex - '0'); }
                        else if (hex >= 'a' && hex <= 'f') { low |= static_cast<unsigned>(hex - 'a' + 10); }
                        else if (hex >= 'A' && hex <= 'F') { low |= static_cast<unsigned>(hex - 'A' + 10); }
                        else { valid = false; break; }
                    }
                    if (valid && low >= 0xDC00 && low <= 0xDFFF) {
                        code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                    } else {
                        p = save;
                    }
                }
                AppendUtf8(out, code);
                break;
            }
            default:
                ok = false;
                return out;
            }
        }
        ok = false;
        return out;
    }

    Json ParseValue(int depth)
    {
        if (depth > 64) { ok = false; return Json(); }
        Skip();
        if (p >= end) { ok = false; return Json(); }

        char ch = *p;
        if (ch == '{') {
            ++p;
            Json object = Json::Object();
            Skip();
            if (p < end && *p == '}') { ++p; return object; }
            while (p < end) {
                Skip();
                std::string key = ParseString();
                if (!ok) { return object; }
                Skip();
                if (p >= end || *p != ':') { ok = false; return object; }
                ++p;
                Json value = ParseValue(depth + 1);
                if (!ok) { return object; }
                object.Set(key, value);
                Skip();
                if (p < end && *p == ',') { ++p; continue; }
                if (p < end && *p == '}') { ++p; return object; }
                ok = false;
                return object;
            }
            ok = false;
            return object;
        }

        if (ch == '[') {
            ++p;
            Json array = Json::Array();
            Skip();
            if (p < end && *p == ']') { ++p; return array; }
            while (p < end) {
                Json value = ParseValue(depth + 1);
                if (!ok) { return array; }
                array.push_back(value);
                Skip();
                if (p < end && *p == ',') { ++p; continue; }
                if (p < end && *p == ']') { ++p; return array; }
                ok = false;
                return array;
            }
            ok = false;
            return array;
        }

        if (ch == '"') { return Json::Str(ParseString()); }
        if (Literal("true")) { return Json::Bool(true); }
        if (Literal("false")) { return Json::Bool(false); }
        if (Literal("null")) { return Json(); }

        if (ch == '-' || (ch >= '0' && ch <= '9')) {
            // JSON 的数字语法在 RFC 8259 §6 中有明确规定——可选的负号、
            // 整数、可选的小数部分、可选的指数——仅此而已。在这里自行解析
            // 而不调用 strtod，可以让约 20 KB 与 locale 相关的转换代码不进
            // 可执行文件（本工具链上体积更大的 std::from_chars 同样不引入）。
            bool negative = *p == '-';
            if (negative) { ++p; }

            double value = 0;
            const char* digits = p;
            while (p < end && *p >= '0' && *p <= '9') { value = value * 10 + (*p++ - '0'); }
            if (p == digits) { ok = false; return Json(); }

            if (p < end && *p == '.') {
                ++p;
                double scale = 0.1;
                const char* fraction = p;
                while (p < end && *p >= '0' && *p <= '9') {
                    value += (*p++ - '0') * scale;
                    scale *= 0.1;
                }
                if (p == fraction) { ok = false; return Json(); }
            }

            if (p < end && (*p == 'e' || *p == 'E')) {
                ++p;
                bool exponentNegative = false;
                if (p < end && (*p == '+' || *p == '-')) { exponentNegative = *p == '-'; ++p; }
                int exponent = 0;
                const char* exponentDigits = p;
                while (p < end && *p >= '0' && *p <= '9') {
                    if (exponent < 10000) { exponent = exponent * 10 + (*p - '0'); }
                    ++p;
                }
                if (p == exponentDigits) { ok = false; return Json(); }
                // 用一张 10 的幂次表代替 pow()：配置文件与桥接协议中的指数
                // 从不超过这个范围，重复相乘也不会给构建带来任何负担。
                static const double kPowers[] = {
                    1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10,
                    1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20,
                };
                while (exponent > 0) {
                    int step = exponent > 20 ? 20 : exponent;
                    value = exponentNegative ? value / kPowers[step - 1] : value * kPowers[step - 1];
                    exponent -= step;
                }
            }

            return Json::Number(negative ? -value : value);
        }

        ok = false;
        return Json();
    }
};

}  // namespace

Json Json::Parse(const std::string& text, bool* okOut)
{
    const char* begin = text.c_str();
    const char* end = begin + text.size();

    // 文件只要被会添加 BOM 的编辑器碰过就会带上 UTF-8 BOM；System.Text.Json
    // 能容忍它，所以不能仅因为开头这三个字节就丢弃这些设置。
    if (text.size() >= 3 &&
        static_cast<unsigned char>(begin[0]) == 0xEF &&
        static_cast<unsigned char>(begin[1]) == 0xBB &&
        static_cast<unsigned char>(begin[2]) == 0xBF) {
        begin += 3;
    }

    Parser parser{ begin, end, true };
    Json value = parser.ParseValue(0);
    parser.Skip();
    bool good = parser.ok && parser.p == parser.end;
    if (okOut) { *okOut = good; }
    return good ? value : Json();
}
