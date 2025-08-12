# Changelog

## [2.0.0] - 2024-08-12

### 🎉 Major Release: Unified Dashboard with Workspace View

#### ✨ New Features

##### **Unified Dashboard Architecture**
- Merged `home.js` and `workspace.js` into single `dashboard.js` server
- Single server on port 3000 (no more confusion with multiple ports)
- Landing page at `/` with view selector
- Routes: `/grid` for card view, `/workspace` for IDE-like view

##### **Workspace View (IDE-like Interface)**
- **Three-panel layout**: Projects sidebar (20%), Terminal (40%), Live Preview (40%)
- **Resizable panels**: Drag splitter bars to resize with 5% snap points
- **Collapsible sidebar**: Hamburger menu to hide/show project list
- **Layout switching**: Toggle between horizontal (side-by-side) and vertical (stacked) layouts
- **Live preview**: Auto-refreshes when `index.html` changes on disk
- **Keyboard shortcuts**: Press 1, 2, 3 to switch to top projects instantly

##### **Terminal Enhancements**
- **Session persistence**: Conversations survive page refreshes
- **Terminal pooling**: Top 5 projects cached for instant switching
- **Project isolation**: Each project has its own separate Claude session
- **Buffer management**: 50KB conversation history preserved
- **Smart restoration**: Uses `--continue` flag when reconnecting

##### **UI/UX Improvements**
- **Drag-and-drop**: Reorder projects in sidebar (saves to YAML)
- **Layout persistence**: All preferences saved to localStorage
- **Smooth animations**: Panel transitions and resizing at 60fps
- **Dark theme**: Consistent dark UI across all views
- **Visual feedback**: Green indicators for saved sessions

#### 🐛 Bug Fixes

##### **Critical Fixes**
- Fixed WebSocket connection errors (removed path-based routing)
- Fixed terminal isolation (each project gets separate session)
- Fixed session persistence (properly restores on refresh)
- Fixed vertical layout rendering issues
- Fixed laggy panel resizing (added requestAnimationFrame)
- Fixed server crashes from undefined variables

##### **Session Management**
- Fixed conversation mixing between projects
- Fixed `/exit` command appearing on restore
- Fixed session restoration for correct project only
- Fixed buffer replay on reconnection

#### 🔧 Technical Improvements

##### **Architecture**
- Single WebSocket server (no path conflicts)
- Proper project ID scoping (no shared state)
- Closure-based terminal isolation
- Efficient memory pooling (max 5 terminals)

##### **Performance**
- Terminal pooling reduces switching latency to ~0ms
- Debounced terminal resizing
- RequestAnimationFrame for smooth dragging
- Smart buffer management (50KB limit)

#### 📁 Files

- **Main Application**: `dashboard.js` - Unified server with all features
- **Legacy Files**: `home.js`, `workspace.js` - Can be removed
- **Configuration**: `projects.yaml` - Project organization
- **Session Data**: `.claude/` directory - Session states

#### 🚀 Usage

```bash
# Install dependencies
npm install

# Start the dashboard
node dashboard.js

# Access at http://localhost:3000
```

#### 🎯 Views

1. **Landing Page** (`/`): Choose between Grid or Workspace view
2. **Grid View** (`/grid`): Card-based layout with project organization
3. **Workspace View** (`/workspace`): IDE-like interface with terminal and preview

#### ⌨️ Keyboard Shortcuts

- **1, 2, 3**: Switch to top 3 projects (workspace view)
- **Esc**: Close modals
- **Search**: Filter projects in sidebar

### Contributors
- Built with Claude's assistance through iterative development
- Session persistence and terminal pooling architecture
- Comprehensive bug fixing and performance optimization

---

## [1.0.0] - 2024-08-11

### Initial Release
- Basic grid view with project cards
- Terminal integration with Claude
- Project organization with YAML configuration