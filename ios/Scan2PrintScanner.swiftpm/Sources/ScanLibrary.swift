import Foundation

struct ScanFile: Identifiable, Hashable {
    let url: URL
    let size: Int
    let date: Date
    var id: URL { url }
    var name: String { url.lastPathComponent }
}

/// Saved scans live in Documents/Scans (visible in the Files app when built with Xcode; in Swift Playgrounds use Share).
final class ScanLibrary: ObservableObject {
    @Published private(set) var files: [ScanFile] = []

    let folder: URL = {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = docs.appendingPathComponent("Scans", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    init() { refresh() }

    func refresh() {
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        let urls = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys)) ?? []
        files = urls.compactMap { url in
            guard let v = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            return ScanFile(url: url, size: v.fileSize ?? 0, date: v.contentModificationDate ?? .distantPast)
        }
        .sorted { $0.date > $1.date }
    }

    @discardableResult
    func save(_ data: Data, name: String, format: ExportFormat) throws -> URL {
        let safe = name.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "[^A-Za-z0-9_\\- ]", with: "_", options: .regularExpression)
        var url = folder.appendingPathComponent((safe.isEmpty ? "scan" : safe) + "." + format.rawValue)
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = folder.appendingPathComponent("\(safe.isEmpty ? "scan" : safe)-\(n).\(format.rawValue)"); n += 1
        }
        try data.write(to: url, options: .atomic)
        refresh()
        return url
    }

    func delete(_ file: ScanFile) {
        try? FileManager.default.removeItem(at: file.url)
        refresh()
    }
}
