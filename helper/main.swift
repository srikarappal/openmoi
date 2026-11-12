// moi_mac_helper: openMoi's window into apps on this Mac, read only.
//
// One command per run: `moi_mac_helper <command>` with its arguments as JSON on stdin, one JSON answer on stdout:
// {"ok": true, "data": ...} or {"ok": false, "kind": "permission" | "unavailable" | "bad_input", "error": "..."}.
//
// The app ladder, as built: A system frameworks (EventKit for Calendar), B Apple Events through JXA for scriptable
// apps (Mail, Notes), and plain folders you opt into for Files. It never clicks or types into another app and never
// writes to one. A permission is asked only by `request`, one capability at a time; `status` never asks.

import CoreServices
import EventKit
import Foundation

let MAX_BODY = 4000
let MAX_ITEMS = 200
let MAIL_BUNDLE = "com.apple.mail"
let NOTES_BUNDLE = "com.apple.Notes"
let FOLDER_DEPTH = 2

struct HelperError: Error {
    let kind: String
    let message: String
}

func answer(_ object: [String: Any]) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{\"ok\":false,\"kind\":\"unavailable\",\"error\":\"could not write the answer\"}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(object["ok"] as? Bool == true ? 0 : 1)
}

func iso(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.string(from: date)
}

func parse_date(_ value: Any?, _ name: String) throws -> Date {
    guard let text = value as? String, let date = ISO8601DateFormatter().date(from: text) else {
        throw HelperError(kind: "bad_input", message: "\(name) must be an ISO 8601 time such as 2026-11-12T00:00:00Z")
    }
    return date
}

func limit_of(_ args: [String: Any], _ fallback: Int) -> Int {
    return max(1, min((args["limit"] as? Int) ?? fallback, MAX_ITEMS))
}

// Calendar (rung A, EventKit).

func calendar_status() -> String {
    switch EKEventStore.authorizationStatus(for: .event) {
    case .fullAccess: return "allowed"
    case .writeOnly: return "denied"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not_asked"
    @unknown default: return "unavailable"
    }
}

func request_calendar() -> String {
    let store = EKEventStore()
    let done = DispatchSemaphore(value: 0)
    store.requestFullAccessToEvents { _, _ in done.signal() }
    done.wait()
    return calendar_status()
}

func calendar_events(_ args: [String: Any]) throws -> [[String: Any]] {
    guard calendar_status() == "allowed" else {
        throw HelperError(kind: "permission", message: "Calendar access is \(calendar_status())")
    }
    let start = try parse_date(args["from"], "from")
    let end = try parse_date(args["to"], "to")
    guard end > start, end.timeIntervalSince(start) <= 31 * 24 * 3600 else {
        throw HelperError(kind: "bad_input", message: "to must come after from, at most 31 days later")
    }
    let store = EKEventStore()
    let events = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: nil))
    return events.prefix(limit_of(args, MAX_ITEMS)).map { event in
        let attendees: [[String: String]] = (event.attendees ?? []).map { person in
            ["name": person.name ?? "", "email": person.url.absoluteString.replacingOccurrences(of: "mailto:", with: "")]
        }
        return [
            "id": event.calendarItemIdentifier,
            "title": event.title ?? "",
            "start": iso(event.startDate),
            "end": iso(event.endDate),
            "all_day": event.isAllDay,
            "location": event.location ?? "",
            "calendar": event.calendar?.title ?? "",
            "notes": String((event.notes ?? "").prefix(MAX_BODY)),
            "attendees": attendees,
        ]
    }
}

// Mail and Notes (rung B, Apple Events through JXA).

func automation_status(_ bundle: String, ask: Bool) -> String {
    let target = NSAppleEventDescriptor(bundleIdentifier: bundle)
    guard let address = target.aeDesc else { return "unavailable" }
    let status = AEDeterminePermissionToAutomateTarget(address, typeWildCard, typeWildCard, ask)
    switch status {
    case noErr: return "allowed"
    case OSStatus(errAEEventNotPermitted): return "denied"
    case OSStatus(errAEEventWouldRequireUserConsent): return "not_asked"
    case OSStatus(procNotFound): return "not_running"
    default: return "unavailable"
    }
}

let MAIL_SCRIPT = """
function run(argv) {
  const args = JSON.parse(argv[0])
  const since = new Date(args.since)
  const Mail = Application("Mail")
  const messages = Mail.inbox.messages
  const total = messages.length
  const found = []
  for (let index = 0; index < Math.min(total, args.scan); index++) {
    const message = messages[index]
    const received = message.dateReceived()
    if (received < since) continue
    const headers = (message.allHeaders() || "").toLowerCase()
    found.push({
      id: message.messageId(),
      subject: message.subject() || "",
      sender: message.sender() || "",
      date: received.toISOString(),
      unsubscribe: headers.indexOf("list-unsubscribe:") >= 0,
      body: (message.content() || "").slice(0, args.body),
    })
    if (found.length >= args.limit) break
  }
  return JSON.stringify(found)
}
"""

let NOTES_SCRIPT = """
function run(argv) {
  const args = JSON.parse(argv[0])
  const notes = Application("Notes").notes
  const found = []
  for (let index = 0; index < Math.min(notes.length, args.limit); index++) {
    const note = notes[index]
    found.push({ id: note.id(), title: note.name() || "", body: (note.plaintext() || "").slice(0, args.body), modified: note.modificationDate().toISOString() })
  }
  return JSON.stringify(found)
}
"""

func run_jxa(_ script: String, _ args: [String: Any]) throws -> Any {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    let argument = String(data: try JSONSerialization.data(withJSONObject: args), encoding: .utf8) ?? "{}"
    process.arguments = ["-l", "JavaScript", "-e", script, argument]
    let output = Pipe()
    let errors = Pipe()
    process.standardOutput = output
    process.standardError = errors
    try process.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    let problem = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        let kind = problem.contains("-1743") || problem.contains("Not authorized") ? "permission" : "unavailable"
        throw HelperError(kind: kind, message: problem.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    return try JSONSerialization.jsonObject(with: data)
}

func mail_messages(_ args: [String: Any]) throws -> Any {
    let status = automation_status(MAIL_BUNDLE, ask: false)
    guard status == "allowed" else {
        throw HelperError(kind: status == "not_running" ? "unavailable" : "permission", message: "Mail access is \(status)")
    }
    let since = try parse_date(args["since"], "since")
    let limit = limit_of(args, 50)
    return try run_jxa(MAIL_SCRIPT, ["since": iso(since), "limit": limit, "scan": limit * 4, "body": MAX_BODY])
}

func notes_list(_ args: [String: Any]) throws -> Any {
    let status = automation_status(NOTES_BUNDLE, ask: false)
    guard status == "allowed" else {
        throw HelperError(kind: status == "not_running" ? "unavailable" : "permission", message: "Notes access is \(status)")
    }
    return try run_jxa(NOTES_SCRIPT, ["limit": limit_of(args, 50), "body": MAX_BODY])
}

// Files: folders you opted into, read as plain folders (newest first), never anything outside them.

func folder_files(_ args: [String: Any]) throws -> [[String: Any]] {
    guard let folders = args["folders"] as? [String], !folders.isEmpty else {
        throw HelperError(kind: "bad_input", message: "folders must list the folders you opted into")
    }
    let manager = FileManager.default
    var found: [(Date, [String: Any])] = []
    for folder in folders {
        let root = URL(fileURLWithPath: (folder as NSString).expandingTildeInPath).standardizedFileURL
        var is_folder: ObjCBool = false
        guard manager.fileExists(atPath: root.path, isDirectory: &is_folder), is_folder.boolValue else {
            throw HelperError(kind: "bad_input", message: "\(folder) is not a folder")
        }
        let keys: [URLResourceKey] = [.isRegularFileKey, .contentModificationDateKey, .fileSizeKey, .isSymbolicLinkKey]
        guard let walker = manager.enumerator(at: root, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
        for case let file as URL in walker {
            if walker.level > FOLDER_DEPTH { walker.skipDescendants(); continue }
            let values = try file.resourceValues(forKeys: Set(keys))
            guard values.isRegularFile == true, values.isSymbolicLink != true, file.standardizedFileURL.path.hasPrefix(root.path + "/") else { continue }
            let modified = values.contentModificationDate ?? Date.distantPast
            found.append((modified, ["path": file.path, "name": file.lastPathComponent, "modified": iso(modified), "size": values.fileSize ?? 0]))
        }
    }
    return found.sorted { $0.0 > $1.0 }.prefix(limit_of(args, 100)).map { $0.1 }
}

func status() -> [String: String] {
    return [
        "calendar": calendar_status(),
        "mail": automation_status(MAIL_BUNDLE, ask: false),
        "notes": automation_status(NOTES_BUNDLE, ask: false),
        "files": "allowed",
    ]
}

func request(_ args: [String: Any]) throws -> [String: String] {
    switch args["capability"] as? String {
    case "calendar": return ["calendar": request_calendar()]
    case "mail": return ["mail": automation_status(MAIL_BUNDLE, ask: true)]
    case "notes": return ["notes": automation_status(NOTES_BUNDLE, ask: true)]
    default: throw HelperError(kind: "bad_input", message: "capability must be calendar, mail or notes")
    }
}

func main() -> Never {
    let arguments = CommandLine.arguments
    guard arguments.count == 2 else {
        answer(["ok": false, "kind": "bad_input", "error": "usage: moi_mac_helper status|request|calendar|mail|notes|files, with JSON arguments on stdin"])
    }
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let parsed = input.isEmpty ? [:] : (try? JSONSerialization.jsonObject(with: input)) as? [String: Any]
    guard let args = parsed else {
        answer(["ok": false, "kind": "bad_input", "error": "the arguments on stdin must be one JSON object"])
    }
    do {
        let data: Any
        switch arguments[1] {
        case "status": data = status()
        case "request": data = try request(args)
        case "calendar": data = try calendar_events(args)
        case "mail": data = try mail_messages(args)
        case "notes": data = try notes_list(args)
        case "files": data = try folder_files(args)
        default: throw HelperError(kind: "bad_input", message: "unknown command \(arguments[1])")
        }
        answer(["ok": true, "data": data])
    } catch let error as HelperError {
        answer(["ok": false, "kind": error.kind, "error": error.message])
    } catch {
        answer(["ok": false, "kind": "unavailable", "error": "\(error)"])
    }
}

main()
