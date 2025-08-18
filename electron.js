const { app, BrowserWindow, Menu, shell, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

let mainWindow;
let serverProcess;
let isUsingExistingServer = false;

// Check if server is already running
function checkServerRunning() {
  return new Promise((resolve) => {
    const options = {
      host: 'localhost',
      port: 3000,
      path: '/',
      method: 'GET',
      timeout: 1000
    };

    const req = http.request(options, (res) => {
      // Server is running
      resolve(true);
    });

    req.on('error', () => {
      // Server is not running
      resolve(false);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });

    req.end();
  });
}

// Start the Express server
function startServer() {
  return new Promise(async (resolve, reject) => {
    // First check if server is already running
    const serverRunning = await checkServerRunning();
    
    if (serverRunning) {
      console.log('🔗 Connecting to existing server on port 3000...');
      isUsingExistingServer = true;
      resolve();
      return;
    }

    console.log('🚀 Starting new server instance...');
    
    // In production, we need to handle the fact that files are in an asar archive
    // So we'll require the dashboard directly instead of spawning it
    if (app.isPackaged) {
      // For packaged app, run the server in the same process
      require('./dashboard.js');
      setTimeout(() => resolve(), 2000); // Give server time to start
      return;
    }
    
    // For development, spawn as separate process
    serverProcess = spawn('node', [path.join(__dirname, 'dashboard.js')], {
      cwd: __dirname,
      env: { ...process.env, ELECTRON_RUN: 'true' }
    });

    serverProcess.stdout.on('data', (data) => {
      console.log(`Server: ${data}`);
      if (data.toString().includes('Unified Dashboard server running')) {
        setTimeout(() => resolve(), 1000); // Give server time to fully start
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error(`Server Error: ${data}`);
    });

    serverProcess.on('error', (error) => {
      console.error('Failed to start server:', error);
      reject(error);
    });
  });
}

function createWindow() {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Overview',
    icon: process.platform === 'darwin' 
      ? path.join(__dirname, 'assets', 'icon.icns')
      : path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    },
    titleBarStyle: 'hiddenInset', // macOS style
    backgroundColor: '#1a1a1a',
    show: false // Don't show until ready
  });

  // Set up the menu
  const template = [
    {
      label: 'Overview',
      submenu: [
        { label: 'About Overview', role: 'about' },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', role: 'redo' },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R', role: 'forceReload' },
        { label: 'Toggle Developer Tools', accelerator: 'F12', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', role: 'zoomIn' },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        { type: 'separator' },
        { label: 'Toggle Fullscreen', accelerator: 'F11', role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Minimize', accelerator: 'CmdOrCtrl+M', role: 'minimize' },
        { label: 'Close', accelerator: 'CmdOrCtrl+W', role: 'close' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open GitHub Repository',
          click: async () => {
            await shell.openExternal('https://github.com/miguelemosreverte/overview');
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // Load the app
  mainWindow.loadURL('http://localhost:3000/workspace');

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Handle window closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Handle external links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// App event handlers
app.whenReady().then(async () => {
  // Set the dock icon for macOS
  if (process.platform === 'darwin') {
    try {
      // Try PNG first as it's more reliable
      const pngPath = path.join(__dirname, 'assets', 'icon.png');
      if (require('fs').existsSync(pngPath)) {
        const { nativeImage } = require('electron');
        const icon = nativeImage.createFromPath(pngPath);
        app.dock.setIcon(icon);
        console.log('Dock icon set successfully');
      }
    } catch (e) {
      console.log('Could not set dock icon:', e.message);
    }
  }
  
  try {
    console.log('Starting Express server...');
    await startServer();
    console.log('Server started, creating window...');
    createWindow();
  } catch (error) {
    console.error('Failed to start:', error);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // Only kill server if we started it ourselves
  if (serverProcess && !isUsingExistingServer) {
    console.log('Stopping server...');
    serverProcess.kill();
  } else if (isUsingExistingServer) {
    console.log('Leaving existing server running...');
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('before-quit', () => {
  // Only kill server if we started it ourselves
  if (serverProcess && !isUsingExistingServer) {
    serverProcess.kill();
  }
});

// Handle server process cleanup
process.on('exit', () => {
  // Only kill server if we started it ourselves
  if (serverProcess && !isUsingExistingServer) {
    serverProcess.kill();
  }
});