# Overview - Project Dashboard

A Node.js web application that provides a centralized dashboard for managing multiple projects with integrated Claude terminal sessions.

## Features

- **Project Dashboard**: Visual overview of all projects with auto-detection and organization
- **Integrated Claude Terminals**: Launch Claude Code sessions directly from the UI with `--dangerously-skip-permissions`
- **Session Persistence**: Maintain Claude sessions across minimize/maximize actions
- **Smart Organization**: Automatic project clustering by category with drag-and-drop reorganization
- **Live Updates**: Real-time project status based on last modification times
- **Session Recovery**: Automatic session state documentation for recovery after crashes

## Installation

```bash
npm install
```

## Usage

Start the server:

```bash
node home.js
```

Access the dashboard at: http://localhost:3000

## Project Organization

Projects are automatically organized into clusters saved in `projects.yaml`:
- Active Traffic Analysis
- AI & Machine Learning  
- Graphics & Visualization
- Data Pipelines
- Simulations & Education
- Database & Testing Tools

## Terminal Sessions

Click the terminal icon on any project to:
- Launch a new Claude session with `--dangerously-skip-permissions`
- Continue existing sessions with `--continue` flag
- Sessions persist when minimized
- Session states saved to `.claude/` directory for recovery

## Technical Stack

- Express.js for web server
- WebSocket for real-time terminal communication
- node-pty for pseudo-terminal creation
- xterm.js for terminal rendering
- js-yaml for configuration management
- Tailwind CSS for styling
- Sortable.js for drag-and-drop functionality

## Configuration

The `projects.yaml` file maintains the project organization structure with priorities and clusters. Edit through the UI or modify directly.

## Session Recovery

Session states are automatically saved to `.claude/status-*.md` files when:
- Terminals are minimized
- Server is shutting down
- Sessions are closed

Use `claude --resume` to recover from saved states if needed.