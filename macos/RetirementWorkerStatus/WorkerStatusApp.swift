import AppKit
import Foundation

private enum WorkerState: String {
    case stopped = "Stopped"
    case starting = "Starting"
    case connected = "Connected"
    case working = "Working"
    case reconnecting = "Reconnecting"
    case error = "Error"
}

private final class WorkerStatusController: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private let statusLine = NSMenuItem(title: "Status: Stopped", action: nil, keyEquivalent: "")
    private let dispatcherLine = NSMenuItem(title: "Dispatcher: not set", action: nil, keyEquivalent: "")
    private let peerLine = NSMenuItem(title: "Peer: -", action: nil, keyEquivalent: "")
    private let batchLine = NSMenuItem(title: "Last batch: -", action: nil, keyEquivalent: "")
    private let totalLine = NSMenuItem(title: "Processed: 0 policies", action: nil, keyEquivalent: "")
    private let rateLine = NSMenuItem(title: "Rate: -", action: nil, keyEquivalent: "")
    private let messageLine = NSMenuItem(title: "Message: -", action: nil, keyEquivalent: "")
    private lazy var startStopItem = NSMenuItem(
        title: "Start Worker",
        action: #selector(toggleWorker),
        keyEquivalent: ""
    )
    private lazy var restartItem = NSMenuItem(
        title: "Restart Worker",
        action: #selector(restartWorker),
        keyEquivalent: ""
    )
    private lazy var dispatcherItem = NSMenuItem(
        title: "Set Dispatcher URL...",
        action: #selector(setDispatcherUrl),
        keyEquivalent: ""
    )

    private var workerProcess: Process?
    private var outputBuffer = Data()
    private var state: WorkerState = .stopped
    private var peerId: String?
    private var lastMessage = "-"
    private var lastBatchPolicies: Int?
    private var lastBatchDurationMs: Int?
    private var lastBatchRate: Double?
    private var totalPolicies = 0

    private var dispatcherUrl: String {
        get {
            UserDefaults.standard.string(forKey: "dispatcherUrl") ?? "ws://localhost:8765"
        }
        set {
            UserDefaults.standard.set(newValue, forKey: "dispatcherUrl")
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        configureMenu()
        updateMenu()
        startWorker()
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopWorker()
    }

    private func configureMenu() {
        statusItem.button?.title = "XC"
        statusItem.button?.toolTip = "XCAppRunner"

        for item in [
            statusLine,
            dispatcherLine,
            peerLine,
            batchLine,
            totalLine,
            rateLine,
            messageLine,
        ] {
            item.isEnabled = false
            menu.addItem(item)
        }
        menu.addItem(.separator())
        startStopItem.target = self
        restartItem.target = self
        dispatcherItem.target = self
        menu.addItem(startStopItem)
        menu.addItem(restartItem)
        menu.addItem(dispatcherItem)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
        menu.items.last?.target = self
        statusItem.menu = menu
    }

    private func workerExecutableUrl() -> URL? {
        if let bundled = Bundle.main.url(forResource: "retirement_worker", withExtension: nil) {
            return bundled
        }
        let cwdFallback = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("flight-engine-rs/target/release/retirement_worker")
        return FileManager.default.isExecutableFile(atPath: cwdFallback.path)
            ? cwdFallback
            : nil
    }

    private func startWorker() {
        guard workerProcess == nil else { return }
        guard let executable = workerExecutableUrl() else {
            state = .error
            lastMessage = "retirement_worker binary not found"
            updateMenu()
            return
        }

        state = .starting
        lastMessage = "Launching worker"
        outputBuffer = Data()
        updateMenu()

        let process = Process()
        process.executableURL = executable
        process.currentDirectoryURL = Bundle.main.resourceURL ?? executable.deletingLastPathComponent()

        var env = ProcessInfo.processInfo.environment
        env["DISPATCHER_URL"] = dispatcherUrl
        env["HOST_DISPLAY_NAME"] = env["HOST_DISPLAY_NAME"] ?? Host.current().localizedName ?? "mac-menu-worker"
        process.environment = env

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.consume(handle.availableData)
        }
        process.terminationHandler = { [weak self] terminated in
            DispatchQueue.main.async {
                guard let self else { return }
                pipe.fileHandleForReading.readabilityHandler = nil
                self.workerProcess = nil
                if self.state != .stopped {
                    self.state = terminated.terminationStatus == 0 ? .stopped : .error
                    self.lastMessage = "Worker exited with code \(terminated.terminationStatus)"
                    self.updateMenu()
                }
            }
        }

        do {
            try process.run()
            workerProcess = process
        } catch {
            state = .error
            lastMessage = "Launch failed: \(error.localizedDescription)"
            updateMenu()
        }
    }

    private func stopWorker() {
        state = .stopped
        lastMessage = "Stopped"
        if let process = workerProcess, process.isRunning {
            process.terminate()
        }
        workerProcess = nil
        updateMenu()
    }

    private func consume(_ data: Data) {
        guard !data.isEmpty else { return }
        outputBuffer.append(data)
        while let range = outputBuffer.firstRange(of: Data([0x0a])) {
            let lineData = outputBuffer.subdata(in: outputBuffer.startIndex..<range.lowerBound)
            outputBuffer.removeSubrange(outputBuffer.startIndex...range.lowerBound)
            if let line = String(data: lineData, encoding: .utf8) {
                DispatchQueue.main.async { [weak self] in
                    self?.handleLogLine(line)
                }
            }
        }
    }

    private func handleLogLine(_ line: String) {
        let message = parseLogMessage(line)
        lastMessage = message.text
        switch message.text {
        case "native worker starting":
            state = .starting
        case "welcomed":
            state = .connected
            peerId = message.json["peerId"] as? String
        case "reconnecting":
            state = .reconnecting
        case "connection ended", "failed to send outbound message":
            state = .reconnecting
        case "batch done":
            state = .working
            let policies = message.json["policies"] as? Int ?? 0
            let duration = message.json["durationMs"] as? Int ?? 0
            lastBatchPolicies = policies
            lastBatchDurationMs = duration
            if policies > 0 && duration > 0 {
                lastBatchRate = Double(policies) * 60_000.0 / Double(duration)
                totalPolicies += policies
            }
        case "batch failed":
            state = .error
        default:
            break
        }
        updateMenu()
    }

    private func parseLogMessage(_ line: String) -> (text: String, json: [String: Any]) {
        let jsonStart = line.firstIndex(of: "{")
        let prefix = jsonStart.map { String(line[..<$0]) } ?? line
        let parts = prefix
            .split(separator: "]")
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: " [")) }
            .filter { !$0.isEmpty }
        let text = parts.last ?? line

        guard let jsonStart else { return (text, [:]) }
        let jsonText = String(line[jsonStart...])
        guard
            let data = jsonText.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data),
            let dict = object as? [String: Any]
        else {
            return (text, [:])
        }
        return (text, dict)
    }

    private func updateMenu() {
        statusItem.button?.title = shortStatusTitle()
        statusLine.title = "Status: \(state.rawValue)"
        dispatcherLine.title = "Dispatcher: \(dispatcherUrl)"
        peerLine.title = "Peer: \(peerId ?? "-")"
        if let policies = lastBatchPolicies, let duration = lastBatchDurationMs {
            batchLine.title = "Last batch: \(policies) policies in \(formatSeconds(duration))"
        } else {
            batchLine.title = "Last batch: -"
        }
        totalLine.title = "Processed: \(totalPolicies) policies"
        rateLine.title = "Rate: \(lastBatchRate.map(formatRate) ?? "-")"
        messageLine.title = "Message: \(lastMessage)"
        startStopItem.title = workerProcess == nil ? "Start Worker" : "Stop Worker"
        restartItem.isEnabled = workerProcess != nil
    }

    private func shortStatusTitle() -> String {
        switch state {
        case .working:
            return "XC \(lastBatchRate.map(formatCompactRate) ?? "work")"
        case .connected:
            return "XC on"
        case .starting:
            return "XC ..."
        case .reconnecting:
            return "XC retry"
        case .error:
            return "XC !"
        case .stopped:
            return "XC off"
        }
    }

    private func formatSeconds(_ milliseconds: Int) -> String {
        String(format: "%.1fs", Double(milliseconds) / 1000.0)
    }

    private func formatRate(_ rate: Double) -> String {
        if rate >= 1000 {
            return String(format: "%.1fk pol/min", rate / 1000)
        }
        return String(format: "%.0f pol/min", rate)
    }

    private func formatCompactRate(_ rate: Double) -> String {
        if rate >= 1000 {
            return String(format: "%.1fk", rate / 1000)
        }
        return String(format: "%.0f/m", rate)
    }

    @objc private func toggleWorker() {
        workerProcess == nil ? startWorker() : stopWorker()
    }

    @objc private func restartWorker() {
        stopWorker()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.startWorker()
        }
    }

    @objc private func setDispatcherUrl() {
        let alert = NSAlert()
        alert.messageText = "Dispatcher URL"
        alert.informativeText = "Example: ws://192.168.68.101:8765"
        alert.addButton(withTitle: "Save and Restart")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = dispatcherUrl
        alert.accessoryView = field
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn {
            dispatcherUrl = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            restartWorker()
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
private let delegate = WorkerStatusController()
app.delegate = delegate
app.run()
