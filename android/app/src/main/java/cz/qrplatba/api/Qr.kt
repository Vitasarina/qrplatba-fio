package cz.qrplatba.api

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import java.io.ByteArrayOutputStream
import java.util.zip.CRC32
import java.util.zip.Deflater

/**
 * Render a SPAYD string to a PNG byte array for the QR endpoint.
 * Uses ZXing to compute the module matrix and writes a minimal PNG by hand
 * (no android.graphics dependency, so this is unit-testable on the JVM too).
 */
object Qr {
    private const val WIDTH = 512
    private const val MARGIN = 2 // modules of quiet zone

    fun spaydToPng(spayd: String): ByteArray {
        val writer = QRCodeWriter()
        val hints = mapOf(
            EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
            EncodeHintType.MARGIN to MARGIN,
            EncodeHintType.CHARACTER_SET to "UTF-8",
        )
        val matrix = writer.encode(spayd, BarcodeFormat.QR_CODE, WIDTH, WIDTH, hints)
        val w = matrix.width
        val h = matrix.height
        // 1 byte/pixel grayscale: 0x00 black, 0xFF white.
        return PngWriter.grayscale(w, h) { x, y -> if (matrix.get(x, y)) 0 else 255 }
    }
}

/** Minimal PNG encoder (grayscale, 8-bit) — enough for a QR image, no platform deps. */
private object PngWriter {
    private val SIGNATURE = byteArrayOf(
        0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    )

    fun grayscale(width: Int, height: Int, pixel: (x: Int, y: Int) -> Int): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(SIGNATURE)

        // IHDR
        val ihdr = ByteArrayOutputStream()
        writeInt(ihdr, width)
        writeInt(ihdr, height)
        ihdr.write(8)   // bit depth
        ihdr.write(0)   // color type 0 = grayscale
        ihdr.write(0)   // compression
        ihdr.write(0)   // filter
        ihdr.write(0)   // interlace
        writeChunk(out, "IHDR", ihdr.toByteArray())

        // IDAT: each scanline prefixed with filter byte 0.
        val raw = ByteArrayOutputStream()
        for (y in 0 until height) {
            raw.write(0)
            for (x in 0 until width) raw.write(pixel(x, y))
        }
        val compressed = deflate(raw.toByteArray())
        writeChunk(out, "IDAT", compressed)

        // IEND
        writeChunk(out, "IEND", ByteArray(0))
        return out.toByteArray()
    }

    private fun deflate(data: ByteArray): ByteArray {
        val deflater = Deflater(Deflater.BEST_SPEED)
        deflater.setInput(data)
        deflater.finish()
        val buffer = ByteArray(8192)
        val out = ByteArrayOutputStream()
        while (!deflater.finished()) {
            val n = deflater.deflate(buffer)
            out.write(buffer, 0, n)
        }
        deflater.end()
        return out.toByteArray()
    }

    private fun writeChunk(out: ByteArrayOutputStream, type: String, data: ByteArray) {
        writeInt(out, data.size)
        val typeBytes = type.toByteArray(Charsets.US_ASCII)
        out.write(typeBytes)
        out.write(data)
        val crc = CRC32()
        crc.update(typeBytes)
        crc.update(data)
        writeInt(out, crc.value.toInt())
    }

    private fun writeInt(out: ByteArrayOutputStream, value: Int) {
        out.write((value ushr 24) and 0xFF)
        out.write((value ushr 16) and 0xFF)
        out.write((value ushr 8) and 0xFF)
        out.write(value and 0xFF)
    }
}
