# Contributing

Thanks for your interest in improving Movie Cast Browser. This guide explains how to set up the project, validate changes, and submit them.

> Bản tiếng Việt ở cuối tài liệu này.

## Code of conduct

By participating in this project you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting started

1. Fork the repository and clone your fork.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the app:
   ```bash
   npm start
   ```

You need Node.js 20 or newer. The first run downloads the Electron binary.

## Project layout

- `src/main.js` is the Electron main process: discovery, casting, IPC handlers.
- `src/preload.js` and `src/webview-preload.js` are the preload bridges.
- `src/renderer/` is the React UI (`App.jsx`, `globals.css`, `main.jsx`).
- `src/components/ui/` holds the shadcn/ui style components.
- `scripts/` holds the check and Electron helper scripts.
- `sample/` holds the local page used by the smoke test.

## Validating changes

Run these before opening a pull request:

```bash
npm run check   # static checks plus the production build
npm run smoke   # optional, needs a display and a local network
```

`npm run check` must pass. It builds the renderer and runs `scripts/check.js`, which fails the build if a required file is missing or if any checked file contains an em dash (U+2014).

## Coding conventions

- Code, identifiers, and comments are written in English.
- Never use the em dash character (U+2014) anywhere in the codebase or docs. Use a regular hyphen, a colon, or rewrite the sentence.
- Keep changes focused and small. Avoid unrelated refactors in the same pull request.
- Match the style of the surrounding code.

## Pull requests

1. Create a feature branch from `main`.
2. Make your change and keep the diff focused.
3. Ensure `npm run check` passes.
4. Open a pull request using the template, describe the change, and link any related issue.

## Reporting issues

Use the issue templates. Include your OS, Node.js version, steps to reproduce, what you expected, and what happened.

---

## Đóng góp (tiếng Việt)

Cảm ơn bạn đã quan tâm cải thiện Movie Cast Browser.

### Bắt đầu

1. Fork repo và clone về máy.
2. Cài dependencies: `npm install`.
3. Chạy app: `npm start`.

Cần Node.js 20 trở lên. Lần chạy đầu sẽ tải Electron binary.

### Kiểm tra trước khi gửi

```bash
npm run check   # kiểm tra tĩnh và build production
npm run smoke   # tùy chọn, cần màn hình và mạng LAN
```

`npm run check` bắt buộc phải pass.

### Quy ước

- Code, tên định danh và comment viết bằng tiếng Anh.
- Tuyệt đối không dùng ký tự em dash (U+2014) ở bất kỳ đâu.
- Giữ thay đổi nhỏ và tập trung, tránh refactor không liên quan.

### Pull request

Tạo branch từ `main`, đảm bảo `npm run check` pass, rồi mở PR theo template và mô tả rõ thay đổi.
