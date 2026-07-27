/**
 * 수동 업로드 이미지에서 위치·촬영정보가 들어갈 수 있는 개인정보 메타데이터를
 * 원본 화소를 재인코딩하지 않고 제거한다.
 */

function invalidImage(message = '이미지 구조가 손상되었어요.') {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}

function stripJpegPrivacyMetadata(buffer) {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
        throw invalidImage();
    }

    const output = [buffer.subarray(0, 2)];
    let offset = 2;
    let removed = false;

    while (offset < buffer.length) {
        const markerStart = offset;
        if (buffer[offset] !== 0xff) throw invalidImage();
        while (offset < buffer.length && buffer[offset] === 0xff) offset++;
        if (offset >= buffer.length) throw invalidImage();

        const marker = buffer[offset++];
        if (marker === 0xd9) {
            output.push(buffer.subarray(markerStart, offset));
            return { buffer: Buffer.concat(output), removed };
        }
        if (marker === 0xda) {
            if (offset + 2 > buffer.length) throw invalidImage();
            const length = buffer.readUInt16BE(offset);
            if (length < 2 || offset + length > buffer.length) throw invalidImage();
            output.push(buffer.subarray(markerStart));
            return { buffer: Buffer.concat(output), removed };
        }

        // TEM 및 restart marker는 길이 필드가 없다.
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            output.push(buffer.subarray(markerStart, offset));
            continue;
        }
        if (offset + 2 > buffer.length) throw invalidImage();
        const length = buffer.readUInt16BE(offset);
        const segmentEnd = offset + length;
        if (length < 2 || segmentEnd > buffer.length) throw invalidImage();

        // APP1: EXIF/XMP, APP13: IPTC, COM: JPEG comment.
        const privateMetadata = marker === 0xe1 || marker === 0xed || marker === 0xfe;
        if (privateMetadata) removed = true;
        else output.push(buffer.subarray(markerStart, segmentEnd));
        offset = segmentEnd;
    }

    throw invalidImage();
}

function stripPngPrivacyMetadata(buffer) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buffer.length < 20 || !buffer.subarray(0, 8).equals(signature)) throw invalidImage();

    const output = [buffer.subarray(0, 8)];
    const privateChunks = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
    let offset = 8;
    let removed = false;
    let sawEnd = false;

    while (offset < buffer.length) {
        if (offset + 12 > buffer.length) throw invalidImage();
        const length = buffer.readUInt32BE(offset);
        const end = offset + 12 + length;
        if (end > buffer.length) throw invalidImage();
        const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
        if (privateChunks.has(type)) removed = true;
        else output.push(buffer.subarray(offset, end));
        offset = end;
        if (type === 'IEND') {
            sawEnd = true;
            break;
        }
    }
    if (!sawEnd) throw invalidImage();
    return { buffer: Buffer.concat(output), removed };
}

function stripWebpPrivacyMetadata(buffer) {
    if (buffer.length < 20
        || buffer.subarray(0, 4).toString('ascii') !== 'RIFF'
        || buffer.subarray(8, 12).toString('ascii') !== 'WEBP') {
        throw invalidImage();
    }

    const chunks = [];
    let offset = 12;
    let removed = false;
    while (offset < buffer.length) {
        if (offset + 8 > buffer.length) throw invalidImage();
        const type = buffer.subarray(offset, offset + 4).toString('ascii');
        const length = buffer.readUInt32LE(offset + 4);
        const end = offset + 8 + length + (length % 2);
        if (end > buffer.length) throw invalidImage();

        if (type === 'EXIF' || type === 'XMP ') {
            removed = true;
        } else {
            const chunk = Buffer.from(buffer.subarray(offset, end));
            if (type === 'VP8X' && length >= 10) {
                // VP8X의 EXIF/XMP 존재 플래그도 함께 제거한다.
                chunk[8] &= ~(0x08 | 0x04);
            }
            chunks.push(chunk);
        }
        offset = end;
    }

    const body = Buffer.concat(chunks);
    const header = Buffer.alloc(12);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(body.length + 4, 4);
    header.write('WEBP', 8, 'ascii');
    return { buffer: Buffer.concat([header, body]), removed };
}

function gifSubBlocksEnd(buffer, offset) {
    while (offset < buffer.length) {
        const length = buffer[offset++];
        if (length === 0) return offset;
        if (offset + length > buffer.length) throw invalidImage();
        offset += length;
    }
    throw invalidImage();
}

function stripGifPrivacyMetadata(buffer) {
    const signature = buffer.subarray(0, 6).toString('ascii');
    if (buffer.length < 14 || (signature !== 'GIF87a' && signature !== 'GIF89a')) {
        throw invalidImage();
    }

    const packed = buffer[10];
    const globalTableLength = packed & 0x80 ? 3 * (2 ** ((packed & 0x07) + 1)) : 0;
    let offset = 13 + globalTableLength;
    if (offset > buffer.length) throw invalidImage();
    const output = [buffer.subarray(0, offset)];
    let removed = false;

    while (offset < buffer.length) {
        const start = offset;
        const introducer = buffer[offset];
        if (introducer === 0x3b) {
            output.push(buffer.subarray(offset, offset + 1));
            return { buffer: Buffer.concat(output), removed };
        }
        if (introducer === 0x21) {
            if (offset + 3 > buffer.length) throw invalidImage();
            const label = buffer[offset + 1];
            const dataStart = offset + 2;
            const end = gifSubBlocksEnd(buffer, dataStart);
            const firstLength = buffer[dataStart] || 0;
            const appId = label === 0xff && firstLength
                ? buffer.subarray(dataStart + 1, dataStart + 1 + firstLength).toString('ascii')
                : '';
            const privateMetadata = label === 0xfe || /^XMP DataXMP/i.test(appId);
            if (privateMetadata) removed = true;
            else output.push(buffer.subarray(start, end));
            offset = end;
            continue;
        }
        if (introducer === 0x2c) {
            if (offset + 10 > buffer.length) throw invalidImage();
            const imagePacked = buffer[offset + 9];
            const localTableLength = imagePacked & 0x80
                ? 3 * (2 ** ((imagePacked & 0x07) + 1))
                : 0;
            const dataStart = offset + 10 + localTableLength;
            if (dataStart + 1 > buffer.length) throw invalidImage();
            const end = gifSubBlocksEnd(buffer, dataStart + 1);
            output.push(buffer.subarray(start, end));
            offset = end;
            continue;
        }
        throw invalidImage();
    }
    throw invalidImage();
}

function verifyAvifHasNoPrivacyMetadata(buffer) {
    const text = buffer.toString('latin1');
    if (text.includes('Exif')
        || /application\/(?:rdf\+xml|xmp)/i.test(text)
        || text.includes('http://ns.adobe.com/xap')) {
        throw invalidImage(
            '이 AVIF 사진에는 제거하기 어려운 위치·촬영 메타데이터가 포함되어 있어요. '
            + 'JPG, PNG 또는 WebP로 변환한 뒤 올려주세요.',
        );
    }
    return { buffer, removed: false };
}

function stripImagePrivacyMetadata(buffer, type) {
    switch (type?.ext) {
        case 'jpg': return stripJpegPrivacyMetadata(buffer);
        case 'png': return stripPngPrivacyMetadata(buffer);
        case 'webp': return stripWebpPrivacyMetadata(buffer);
        case 'gif': return stripGifPrivacyMetadata(buffer);
        case 'avif': return verifyAvifHasNoPrivacyMetadata(buffer);
        default: throw invalidImage('지원하지 않는 이미지 형식이에요.');
    }
}

module.exports = {
    stripImagePrivacyMetadata,
    stripJpegPrivacyMetadata,
    stripPngPrivacyMetadata,
    stripWebpPrivacyMetadata,
    stripGifPrivacyMetadata,
    verifyAvifHasNoPrivacyMetadata,
};
