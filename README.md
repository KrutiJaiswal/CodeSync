# CodeSync
A real-time collaborative code editor that allows developers to code together, execute programs in multiple languages, chat with teammates, and debug code using an AI-powered assistant.
# CodeSync

A real-time collaborative code editor that enables developers to write, execute, and debug code together in a shared workspace.

## Features

- Real-time collaborative code editing with live cursors.
- Code execution in 8 programming languages.
- AI-powered debugging using Google Gemini.
- Collaborative rooms with integrated live chat.
- Email and Google authentication.
- GitHub integration for pushing code.

## Tech Stack

| Frontend                | React, TypeScript, Vite, Tailwind CSS |
| Backend                 | Node.js, Express.js |
| Real-time Collaboration | Socket.IO, Yjs |
| Database                | MongoDB |
| Code Editor             | Monaco Editor |
| Authentication          | JWT, Google OAuth |
| AI & Compiler           | Gemini AI, Judge0 |

## Supported Languages

JavaScript, TypeScript, Python, Java, C, C++, Rust, and Go.

## Getting Started

```bash
git clone https://github.com/KrutiJaiswal/CodeSync.git
cd CodeSync
npm install
```

Create a `.env` file using `.env.example` as a reference and configure the required credentials.

Start the development server:

```bash
npm run dev
```

Open `http://localhost:3000` in your browser.

## Author

Developed by [Kruti Jaiswal](https://github.com/KrutiJaiswal).
