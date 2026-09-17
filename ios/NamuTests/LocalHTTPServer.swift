import Foundation
import Network

/// Minimal in-process HTTP/1.1 fault server for the transfer integration
/// tests (the same role model-release's fault server plays for manual runs).
final class LocalHTTPServer {
  struct Response {
    var status = 200
    var headers = [String: String]()
    var body = Data()
    /// Omit Content-Length and delimit the body by closing the connection.
    var omitContentLength = false
    /// Send the body in slices with a pause between them (slow link).
    var sliceSize: Int?
    var sliceDelay: TimeInterval = 0
  }

  private let listener: NWListener
  private let queue = DispatchQueue(label: "namu.tests.http")
  private var handlers = [String: (Int) -> Response]()
  private var hits = [String: Int]()
  private(set) var port: UInt16 = 0

  init() throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
    parameters.allowLocalEndpointReuse = true
    listener = try NWListener(using: parameters)
  }

  var origin: String { "http://localhost:\(port)" }

  /// `handler` receives the 1-based request count for that path.
  func route(_ path: String, _ handler: @escaping (Int) -> Response) {
    queue.sync { handlers[path] = handler }
  }

  func requestCount(_ path: String) -> Int {
    queue.sync { hits[path] ?? 0 }
  }

  func start() throws {
    let ready = DispatchSemaphore(value: 0)
    listener.stateUpdateHandler = { state in
      if case .ready = state { ready.signal() }
      if case .failed = state { ready.signal() }
    }
    listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
    listener.start(queue: queue)
    _ = ready.wait(timeout: .now() + 5)
    guard let port = listener.port?.rawValue, port != 0 else {
      throw NSError(domain: "LocalHTTPServer", code: 1)
    }
    self.port = port
  }

  func stop() {
    listener.cancel()
  }

  private func accept(_ connection: NWConnection) {
    connection.start(queue: queue)
    receive(connection, buffer: Data())
  }

  private func receive(_ connection: NWConnection, buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
      guard let self else { return }
      var buffer = buffer
      if let data { buffer.append(data) }
      if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
        let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
        self.respond(connection, requestLine: head.components(separatedBy: "\r\n").first ?? "")
      } else if isComplete || error != nil {
        connection.cancel()
      } else {
        self.receive(connection, buffer: buffer)
      }
    }
  }

  private func respond(_ connection: NWConnection, requestLine: String) {
    let parts = requestLine.split(separator: " ")
    let path = parts.count > 1 ? String(parts[1]) : "/"
    hits[path, default: 0] += 1
    let response = handlers[path]?(hits[path] ?? 1) ?? Response(status: 404, body: Data("not found".utf8))

    var head = "HTTP/1.1 \(response.status) \(response.status == 200 ? "OK" : "Status")\r\n"
    var headers = response.headers
    headers["Connection"] = "close"
    if !response.omitContentLength { headers["Content-Length"] = String(response.body.count) }
    for (name, value) in headers { head += "\(name): \(value)\r\n" }
    head += "\r\n"

    connection.send(content: Data(head.utf8), completion: .contentProcessed { [weak self] _ in
      self?.sendBody(connection, body: response.body, offset: 0, response: response)
    })
  }

  private func sendBody(_ connection: NWConnection, body: Data, offset: Int, response: Response) {
    guard offset < body.count else {
      connection.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in
        connection.cancel()
      })
      return
    }
    let size = response.sliceSize ?? body.count
    let end = min(body.count, offset + size)
    let slice = body.subdata(in: (body.startIndex + offset)..<(body.startIndex + end))
    connection.send(content: slice, completion: .contentProcessed { [weak self] error in
      guard error == nil else { connection.cancel(); return }
      self?.queue.asyncAfter(deadline: .now() + response.sliceDelay) {
        self?.sendBody(connection, body: body, offset: end, response: response)
      }
    })
  }
}
