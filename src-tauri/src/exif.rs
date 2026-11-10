//! 带 EXIF 方向的外部图片解码。
//!
//! 手机拍摄 / 部分截图工具把「摆正」信息写在 EXIF 里，像素本身是躺倒的。
//! 修图要按像素运算并在预览里直接展示，必须先摆正，否则用户看到的和落盘的方向不一致。

use image::metadata::Orientation;

/// 只读 EXIF 方向，不付解码像素的代价。
///
/// 上送服务商前用它判断「原始字节是否带方向标签」：带标签的原图像素是躺倒的，
/// 而本地画布蒙版已经摆正，直接上传会让两者错位。
pub fn orientation_of(bytes: &[u8]) -> Orientation {
    use image::ImageDecoder;

    image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()
        .and_then(|reader| reader.into_decoder().ok())
        .and_then(|mut decoder| decoder.orientation().ok())
        .unwrap_or(Orientation::NoTransforms)
}

/// 解码并按 EXIF 方向摆正；所有外部图片输入应优先走这里。
pub fn decode_oriented(bytes: &[u8]) -> Result<image::DynamicImage, String> {
    use image::ImageDecoder;

    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("图片格式无法识别: {e}"))?;
    reader.limits(crate::image_store::decode_limits());
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| format!("图片解码失败: {e}"))?;
    // 方向元数据必须在 from_decoder 之前读：解码器会被消费掉
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut img =
        image::DynamicImage::from_decoder(decoder).map_err(|e| format!("图片解码失败: {e}"))?;
    // 像素上限按摆正前的原始尺寸判断，与 decode_limited 口径一致
    crate::image_store::ensure_pixel_budget(img.width(), img.height())?;
    img.apply_orientation(orientation);
    Ok(img)
}

/// 测试夹具：手搓带 EXIF 方向的 JPEG，避免为写 EXIF 引入新依赖。
#[cfg(test)]
pub(crate) mod test_fixtures {
    /// 在 SOI（`FF D8`）之后插入只含方向标签的最小 APP1（Exif）段。
    pub(crate) fn jpeg_with_orientation(width: u32, height: u32, orientation: u16) -> Vec<u8> {
        use image::ImageEncoder;

        let img = image::RgbImage::from_pixel(width, height, image::Rgb([200, 100, 50]));
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 90)
            .write_image(img.as_raw(), width, height, image::ExtendedColorType::Rgb8)
            .expect("编码测试 JPEG");
        assert_eq!(&jpeg[..2], [0xFF, 0xD8], "JPEG 应以 SOI 开头");

        let mut payload = Vec::new();
        payload.extend_from_slice(b"Exif\0\0");
        // TIFF 头：小端、42、IFD0 位于偏移 8
        payload.extend_from_slice(&[0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00]);
        payload.extend_from_slice(&[0x01, 0x00]); // IFD0 只有 1 个条目
        payload.extend_from_slice(&[0x12, 0x01, 0x03, 0x00]); // tag 0x0112、type 3（SHORT）
        payload.extend_from_slice(&[0x01, 0x00, 0x00, 0x00]); // count = 1
        payload.extend_from_slice(&orientation.to_le_bytes()); // 值占前 2 字节
        payload.extend_from_slice(&[0x00, 0x00]); // 值补齐到 4 字节
        payload.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // 下一个 IFD = 0

        let mut out = Vec::with_capacity(jpeg.len() + payload.len() + 4);
        // SOI 之后插入 APP1；段长含自身 2 字节，不含 0xFF 0xE1
        out.extend_from_slice(&jpeg[..2]);
        out.extend_from_slice(&[0xFF, 0xE1]);
        let seg_len = u16::try_from(payload.len() + 2).expect("APP1 段长");
        out.extend_from_slice(&seg_len.to_be_bytes());
        out.extend_from_slice(&payload);
        out.extend_from_slice(&jpeg[2..]);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageEncoder;

    fn png_bytes(img: &image::RgbImage) -> Vec<u8> {
        let mut out = Vec::new();
        image::codecs::png::PngEncoder::new(&mut out)
            .write_image(
                img.as_raw(),
                img.width(),
                img.height(),
                image::ExtendedColorType::Rgb8,
            )
            .expect("编码测试 PNG");
        out
    }

    #[test]
    fn decode_plain_png() {
        let img = image::RgbImage::from_pixel(24, 12, image::Rgb([10, 20, 30]));
        let decoded = decode_oriented(&png_bytes(&img)).expect("普通 PNG 应解码成功");
        assert_eq!((decoded.width(), decoded.height()), (24, 12));
        assert_eq!(decoded.to_rgb8().get_pixel(0, 0).0, [10, 20, 30]);
    }

    #[test]
    fn invalid_bytes_return_error() {
        // 只断言错误而不 panic：修图命令必须能把脏输入变成用户可见的提示
        assert!(decode_oriented(b"not-an-image").is_err());
        assert!(decode_oriented(&[]).is_err());
    }

    /// 方向 6（Rotate90）：只读元数据也能拿到方向，摆正后宽高互换
    #[test]
    fn exif_orientation_six_is_read_and_applied() {
        let jpeg = test_fixtures::jpeg_with_orientation(8, 4, 6);
        assert_eq!(orientation_of(&jpeg), Orientation::Rotate90);
        let decoded = decode_oriented(&jpeg).expect("带 EXIF 的 JPEG 应解码成功");
        assert_eq!(
            (decoded.width(), decoded.height()),
            (4, 8),
            "方向 6 应交换宽高"
        );
        // 无方向标签的输入（PNG / 脏数据）一律视为不旋转
        let plain = image::RgbImage::from_pixel(3, 2, image::Rgb([1, 2, 3]));
        assert_eq!(
            orientation_of(&png_bytes(&plain)),
            Orientation::NoTransforms
        );
        assert_eq!(orientation_of(b"not-an-image"), Orientation::NoTransforms);
        assert_eq!(orientation_of(&[]), Orientation::NoTransforms);
    }
}
