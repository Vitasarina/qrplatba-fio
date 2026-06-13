package cz.qrplatba

import android.content.Context
import cz.qrplatba.gateway.ModeGateway
import cz.qrplatba.persistence.JsonSessionRepository
import cz.qrplatba.server.AppConfig
import cz.qrplatba.server.AppServer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File

/**
 * Process-wide singleton owning the embedded server, repository, and the matching
 * poller coroutine. The foreground service drives start/stop; the WebView just
 * loads http://127.0.0.1:8080/display.
 */
object ServerHolder {
    @Volatile private var server: AppServer? = null
    private var pollerScope: CoroutineScope? = null
    private var pollerJob: Job? = null

    val isRunning: Boolean get() = server != null

    @Synchronized
    fun start(context: Context) {
        if (server != null) return
        val appContext = context.applicationContext
        val config = AppConfig()

        val dataFile = File(appContext.filesDir, "qr-state.json")
        val repo = JsonSessionRepository(dataFile)
        // Mode is decided per poll by the stored token: blank -> simulation, set -> Fio.
        val gateway = ModeGateway(repo)

        val srv = AppServer(
            config = config,
            repo = repo,
            gateway = gateway,
            assetLoader = { path ->
                try {
                    appContext.assets.open(path).use { it.readBytes() }
                } catch (e: Exception) {
                    null
                }
            },
        )
        srv.start()
        server = srv

        val scope = CoroutineScope(Dispatchers.IO + Job())
        pollerScope = scope
        pollerJob = scope.launch {
            while (isActive) {
                try {
                    srv.matching.tick()
                } catch (e: Exception) {
                    // never let a poll error kill the loop
                }
                delay(config.pollIntervalMs)
            }
        }
    }

    @Synchronized
    fun stop() {
        pollerJob?.cancel()
        pollerJob = null
        pollerScope = null
        server?.stop()
        server = null
    }
}
