package org.namuai.offline.core.transfer

data class NetworkState(val connected: Boolean, val metered: Boolean)

/** Connectivity seam. Android: ConnectivityManager default-network callback. */
interface NetworkPolicy {
    fun current(): NetworkState
}

/**
 * DL-006: unmetered only unless the user consented to metered use for THIS
 * transfer. Consent is per transfer and never inherited by an update.
 */
object NetworkRule {
    fun usable(state: NetworkState, meteredConsent: Boolean): Boolean =
        state.connected && (!state.metered || meteredConsent)
}
