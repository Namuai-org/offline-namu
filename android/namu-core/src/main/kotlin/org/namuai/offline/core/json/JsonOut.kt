package org.namuai.offline.core.json

/**
 * Minimal JSON serializer for snapshots, active.json and markers. Accepts
 * Map<String, Any?>, List<Any?>, String, Long/Int, Boolean and null. Byte
 * counts stay exact integers (contract: JSON numbers below 2^53).
 */
object JsonOut {
    fun stringify(value: Any?): String {
        val sb = StringBuilder()
        write(sb, value)
        return sb.toString()
    }

    private fun write(sb: StringBuilder, value: Any?) {
        when (value) {
            null -> sb.append("null")
            is String -> quote(sb, value)
            is Boolean -> sb.append(if (value) "true" else "false")
            is Int -> sb.append(value.toString())
            is Long -> sb.append(value.toString())
            is Map<*, *> -> {
                sb.append('{')
                var first = true
                for ((k, v) in value) {
                    if (!first) sb.append(',')
                    first = false
                    quote(sb, k as String)
                    sb.append(':')
                    write(sb, v)
                }
                sb.append('}')
            }
            is List<*> -> {
                sb.append('[')
                for ((index, item) in value.withIndex()) {
                    if (index > 0) sb.append(',')
                    write(sb, item)
                }
                sb.append(']')
            }
            else -> throw IllegalArgumentException("unsupported JSON value")
        }
    }

    private fun quote(sb: StringBuilder, s: String) {
        sb.append('"')
        for (c in s) {
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c.code < 0x20 || c == ' ' || c == ' ' -> {
                    sb.append("\\u")
                    sb.append(c.code.toString(16).padStart(4, '0'))
                }
                else -> sb.append(c)
            }
        }
        sb.append('"')
    }
}
