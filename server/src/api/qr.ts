import QRCode from "qrcode";

/** Render a SPAYD string to a PNG buffer for the QR endpoint. */
export async function spaydToPng(spayd: string): Promise<Buffer> {
  return QRCode.toBuffer(spayd, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 512,
  });
}
