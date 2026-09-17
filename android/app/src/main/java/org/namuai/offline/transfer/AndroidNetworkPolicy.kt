package org.namuai.offline.transfer

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import org.namuai.offline.core.transfer.NetworkPolicy
import org.namuai.offline.core.transfer.NetworkState

/**
 * DL-006: connected/metered from the default network. "Connected" requires a
 * validated internet capability so captive portals count as waiting, not as a
 * usable network.
 */
class AndroidNetworkPolicy(context: Context, private val onChanged: () -> Unit) : NetworkPolicy {
    private val manager = context.applicationContext.getSystemService(ConnectivityManager::class.java)

    @Volatile private var cached: NetworkState? = null

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            publish(toState(capabilities))
        }

        override fun onLost(network: Network) {
            publish(NetworkState(connected = false, metered = false))
        }
    }

    fun start() {
        try {
            manager?.registerDefaultNetworkCallback(callback)
        } catch (e: RuntimeException) {
            // Falls back to on-demand queries in current().
        }
    }

    override fun current(): NetworkState = cached ?: query()

    private fun query(): NetworkState {
        val m = manager ?: return NetworkState(connected = false, metered = false)
        val capabilities = try {
            m.activeNetwork?.let { m.getNetworkCapabilities(it) }
        } catch (e: RuntimeException) {
            null
        }
        return if (capabilities == null) NetworkState(connected = false, metered = false) else toState(capabilities)
    }

    private fun toState(capabilities: NetworkCapabilities): NetworkState {
        val connected = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        val metered = !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        return NetworkState(connected, metered)
    }

    private fun publish(state: NetworkState) {
        val changed = cached != state
        cached = state
        if (changed) onChanged()
    }
}
