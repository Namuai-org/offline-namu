package org.namuai.offline.core.testing

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList

sealed class Fault {
    /** Correct headers, but the socket closes after [bodyBytes] of the body (T03, T05 truncated). */
    class DropAfter(val bodyBytes: Int) : Fault()

    /** Full 200 body even when a Range was requested (T04). */
    object IgnoreRange : Fault()

    /** 206 whose Content-Range does not match the request (T05). */
    object WrongContentRange : Fault()

    /** 206 carrying a different ETag than the one stored (T05). */
    object ChangedEtag : Fault()
    class Status(val code: Int, val retryAfter: String? = null) : Fault()

    /** Chunked 200 body that is [extraBytes] longer than the artifact (T07). */
    class Oversized(val extraBytes: Int) : Fault()

    /** 200 whose Content-Length header announces [declared] bytes (T07). */
    class DeclaredLength(val declared: Long) : Fault()
    class Redirect(val location: String) : Fault()
    object GzipEncoded : Fault()
}

class SeenRequest(val path: String, val range: String?, val ifRange: String?, val acceptEncoding: String?)

/** In-process fault server equivalent to tools/fault-server for the JVM tests. */
class FaultServer(var artifact: ByteArray, var artifactPath: String, var etag: String? = "\"v1\"") {
    val server = MockWebServer()
    val faults = ConcurrentLinkedQueue<Fault>()
    val requests = CopyOnWriteArrayList<SeenRequest>()
    @Volatile var stableJson: ByteArray? = null

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = respond(request)
        }
        server.start()
    }

    val origin: String get() = server.url("/").toString().trimEnd('/')
    fun shutdown() = server.shutdown()
    fun artifactRequests(): List<SeenRequest> = requests.filter { it.path == "/$artifactPath" }

    private fun respond(request: RecordedRequest): MockResponse {
        val path = request.path ?: "/"
        requests.add(SeenRequest(path, request.getHeader("Range"), request.getHeader("If-Range"), request.getHeader("Accept-Encoding")))
        if (path == "/releases/stable.json") {
            val body = stableJson ?: return MockResponse().setResponseCode(404)
            return MockResponse().setResponseCode(200).setBody(Buffer().write(body))
        }
        if (path != "/$artifactPath") return MockResponse().setResponseCode(404)

        val total = artifact.size
        val rangeHeader = request.getHeader("Range")
        val ifRange = request.getHeader("If-Range")
        val start = rangeHeader?.removePrefix("bytes=")?.removeSuffix("-")?.toIntOrNull()
        val honourRange = start != null && (ifRange == null || ifRange == etag)

        val fault = faults.poll()
        if (fault is Fault.Status) {
            val r = MockResponse().setResponseCode(fault.code)
            fault.retryAfter?.let { r.setHeader("Retry-After", it) }
            return r
        }
        if (fault is Fault.Redirect) {
            return MockResponse().setResponseCode(302).setHeader("Location", fault.location)
        }
        if (honourRange && start!! >= total && fault == null) {
            return MockResponse().setResponseCode(416).setHeader("Content-Range", "bytes */$total")
        }

        val partial = honourRange && fault !is Fault.IgnoreRange
        val from = if (partial) start!! else 0
        val slice = artifact.copyOfRange(from, total)
        val response = MockResponse().setResponseCode(if (partial) 206 else 200)
        etag?.let { response.setHeader("ETag", it) }
        if (partial) response.setHeader("Content-Range", "bytes $from-${total - 1}/$total")

        when (fault) {
            is Fault.DropAfter -> {
                val n = minOf(fault.bodyBytes, slice.size)
                response.setBody(Buffer().write(slice, 0, n))
                response.setHeader("Content-Length", slice.size.toString())
                response.socketPolicy = SocketPolicy.DISCONNECT_AT_END
            }
            Fault.WrongContentRange -> {
                response.setBody(Buffer().write(slice))
                response.setHeader("Content-Range", "bytes ${from + 1}-${total - 1}/$total")
            }
            Fault.ChangedEtag -> {
                response.setBody(Buffer().write(slice))
                response.setHeader("ETag", "\"changed\"")
            }
            is Fault.Oversized -> {
                val big = Buffer().write(slice).write(ByteArray(fault.extraBytes))
                response.setChunkedBody(big, 64 * 1024)
            }
            is Fault.DeclaredLength -> {
                response.setBody(Buffer().write(slice))
                response.setHeader("Content-Length", fault.declared.toString())
                response.socketPolicy = SocketPolicy.DISCONNECT_AT_END
            }
            Fault.GzipEncoded -> {
                response.setBody(Buffer().write(slice))
                response.setHeader("Content-Encoding", "gzip")
            }
            else -> response.setBody(Buffer().write(slice))
        }
        return response
    }
}
