"use strict";

/* ============================================================================
 *  Скрытие текста в изображении (RGB-стеганография «изменение канала на 1»)
 *
 *  Файл разделён на две части:
 *    ЧАСТЬ 1 — чистые функции алгоритма (никакого DOM и Canvas, их легко
 *              читать и тестировать отдельно от браузера);
 *    ЧАСТЬ 2 — работа с интерфейсом, файлами и Canvas.
 *
 *  Как устроен алгоритм:
 *    ТЕКСТ -> UTF-8 -> байты -> биты
 *    [32 бита длины][биты текста]
 *    бит 0 -> значение RGB-канала оставляем как есть;
 *    бит 1 -> значение RGB-канала меняем ровно на 1 (+1, а для 255 это -1);
 *    альфа-канал (A) не трогаем никогда.
 *
 *  Дешифрование: сравниваем исходное и зашифрованное изображения.
 *    каналы равны -> бит 0, каналы различаются -> бит 1.
 * ========================================================================== */

/* [PURE-BEGIN] — здесь только математика алгоритма, без обращений к браузеру */

/** Размер заголовка в битах (сколько байт занимает текст). */
var HEADER_BITS = 32;

/**
 * Текст -> массив байтов UTF-8.
 * @param {string} text
 * @returns {Uint8Array}
 */
function textToBytes(text) {
  return new TextEncoder().encode(text);
}

/**
 * Байты UTF-8 -> текст. Ошибка fatal:true нужна, чтобы заметить испорченные данные.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToText(bytes) {
  var decoder = new TextDecoder("utf-8", { fatal: true });
  return decoder.decode(bytes);
}

/**
 * Байты -> последовательность битов (старший бит байта идёт первым).
 * Пример: [65] -> [0,1,0,0,0,0,0,1]
 * @param {Uint8Array} bytes
 * @returns {Uint8Array} массив из нулей и единиц
 */
function bytesToBits(bytes) {
  var bits = new Uint8Array(bytes.length * 8);
  var position = 0;

  for (var i = 0; i < bytes.length; i++) {
    for (var bit = 7; bit >= 0; bit--) {
      bits[position] = (bytes[i] >> bit) & 1;
      position++;
    }
  }

  return bits;
}

/**
 * Биты -> байты.
 * @param {Uint8Array} bits
 * @param {number} offset сколько первых битов пропустить (обычно 32 бита заголовка)
 * @returns {Uint8Array}
 */
function bitsToBytes(bits, offset) {
  if (offset === undefined) offset = 0;

  var count = Math.floor((bits.length - offset) / 8);
  var bytes = new Uint8Array(count);

  for (var i = 0; i < count; i++) {
    var byte = 0;
    for (var bit = 0; bit < 8; bit++) {
      byte = (byte << 1) | bits[offset + i * 8 + bit];
    }
    bytes[i] = byte;
  }

  return bytes;
}

/**
 * Длина текста в байтах -> 32 бита заголовка (старший бит первый).
 * @param {number} byteLength
 * @returns {Uint8Array}
 */
function lengthToHeaderBits(byteLength) {
  if (byteLength < 0 || byteLength > 4294967295) {
    throw new Error(
      "Сообщение слишком большое: его длина не помещается в 32-битный заголовок.",
    );
  }

  var bits = new Uint8Array(HEADER_BITS);
  for (var i = 0; i < HEADER_BITS; i++) {
    bits[i] = (byteLength >>> (31 - i)) & 1;
  }
  return bits;
}

/**
 * 32 бита заголовка -> число (количество байт текста).
 * @param {Uint8Array} bits
 * @returns {number}
 */
function headerBitsToLength(bits) {
  var value = 0;
  for (var i = 0; i < HEADER_BITS; i++) {
    value = value * 2 + bits[i];
  }
  return value;
}

/**
 * Полный поток битов для записи: [32 бита длины][биты текста].
 * @param {string} text
 * @returns {Uint8Array}
 */
function buildBitStream(text) {
  var bytes = textToBytes(text);
  var header = lengthToHeaderBits(bytes.length);
  var textBits = bytesToBits(bytes);

  var bits = new Uint8Array(header.length + textBits.length);
  bits.set(header, 0);
  bits.set(textBits, header.length);

  return bits;
}

/**
 * Вместимость изображения.
 * 1 пиксель = 3 канала = 3 бита. Из общего числа битов вычитаем заголовок.
 * @param {number} width
 * @param {number} height
 * @returns {{totalBits: number, totalChannels: number, maxTextBytes: number}}
 */
function calculateCapacity(width, height) {
  var totalBits = width * height * 3;

  return {
    totalBits: totalBits,
    totalChannels: totalBits,
    maxTextBytes: Math.max(0, Math.floor((totalBits - HEADER_BITS) / 8)),
  };
}

/**
 * Номеру RGB-канала (0,1,2,3,4,...) соответствует индекс в ImageData.data.
 * ImageData.data = R G B A R G B A R G B A ...
 * @param {number} channelNumber
 * @returns {number}
 */
function channelToDataIndex(channelNumber) {
  var pixel = Math.floor(channelNumber / 3);
  var component = channelNumber % 3; // 0 = R, 1 = G, 2 = B
  return pixel * 4 + component;
}

/**
 * Записать один бит в значение канала.
 *   бит 0 -> значение не меняется;
 *   бит 1 -> значение меняется ровно на 1 (255 -> 254, иначе -> +1).
 * @param {number} value значение канала 0..255
 * @param {number} bit   0 или 1
 * @returns {number} новое значение канала
 */
function encodeBitIntoChannel(value, bit) {
  if (bit === 0) {
    return value; // 120 -> 120
  }

  if (value === 255) {
    return 254; // 255 -> 254 (256 получить нельзя)
  }

  return value + 1; // 0 -> 1, 1 -> 2, 120 -> 121, 254 -> 255
}

/**
 * Прочитать бит из пары «значение в исходном / значение в зашифрованном».
 * @param {number} originalValue
 * @param {number} encryptedValue
 * @returns {number} 0 или 1
 */
function decodeBitFromChannels(originalValue, encryptedValue) {
  return originalValue === encryptedValue ? 0 : 1;
}

/**
 * Записать поток битов в пиксели.
 * Исходный массив не меняется — возвращается копия с изменениями.
 * @param {Uint8ClampedArray} sourceData ImageData.data исходного изображения
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} bits
 * @returns {{data: Uint8ClampedArray, usedChannels: number, changedChannels: number, totalChannels: number}}
 */
function encodeMessage(sourceData, width, height, bits) {
  var data = new Uint8ClampedArray(sourceData);
  var totalChannels = width * height * 3;

  if (bits.length > totalChannels) {
    throw new Error(
      "Сообщение не помещается в изображение: требуется " +
        bits.length +
        " бит, а доступно " +
        totalChannels +
        " бит.",
    );
  }

  var bitIndex = 0;
  var changedChannels = 0;

  for (var i = 0; i < data.length && bitIndex < bits.length; i += 4) {
    // Проходим по R, G, B. Индекс i + 3 — это альфа-канал, его не трогаем.
    for (var channel = 0; channel < 3 && bitIndex < bits.length; channel++) {
      var index = i + channel;
      var oldValue = data[index];
      var newValue = encodeBitIntoChannel(oldValue, bits[bitIndex]);

      if (newValue !== oldValue) changedChannels++;

      data[index] = newValue;
      bitIndex++;
    }
  }

  return {
    data: data,
    usedChannels: bits.length,
    changedChannels: changedChannels,
    totalChannels: totalChannels,
  };
}

/**
 * Прочитать первые count битов, сравнивая два изображения побайтово по каналам R, G, B.
 * @param {Uint8ClampedArray} originalData
 * @param {Uint8ClampedArray} encryptedData
 * @param {number} count
 * @returns {Uint8Array}
 */
function readBits(originalData, encryptedData, count) {
  var totalChannels = (originalData.length / 4) * 3;

  if (count > totalChannels) {
    throw new Error(
      "Недостаточно данных для расшифровки: в изображении меньше " +
        count +
        " битов.",
    );
  }

  var bits = new Uint8Array(count);

  for (var i = 0; i < count; i++) {
    var index = channelToDataIndex(i);
    bits[i] = decodeBitFromChannels(originalData[index], encryptedData[index]);
  }

  return bits;
}

/**
 * Полное дешифрование: два ImageData.data -> исходный текст.
 * @param {Uint8ClampedArray} originalData
 * @param {Uint8ClampedArray} encryptedData
 * @returns {string}
 */
function decodeMessage(originalData, encryptedData) {
  if (originalData.length !== encryptedData.length) {
    throw new Error(
      "Исходное и зашифрованное изображения имеют разный размер.",
    );
  }

  var totalChannels = (originalData.length / 4) * 3;

  if (totalChannels < HEADER_BITS) {
    throw new Error(
      "Изображения слишком маленькие: не хватает места даже для 32-битного заголовка.",
    );
  }

  // 1. Читаем заголовок — сколько байт текста записано.
  var headerBits = readBits(originalData, encryptedData, HEADER_BITS);
  var byteLength = headerBitsToLength(headerBits);

  if (byteLength === 0) {
    throw new Error(
      "Заголовок содержит некорректную длину (0 байт). " +
        "Похоже, что в этом изображении нет скрытого текста либо изображения не отличаются нужными каналами.",
    );
  }

  // 2. Проверяем, что столько данных в изображении вообще есть.
  var neededChannels = HEADER_BITS + byteLength * 8;

  if (neededChannels > totalChannels) {
    var maxBytes = Math.floor((totalChannels - HEADER_BITS) / 8);
    throw new Error(
      "Заголовок заявляет " +
        byteLength.toLocaleString("ru-RU") +
        " байт текста, но в изображение " +
        "могло поместиться не больше " +
        maxBytes.toLocaleString("ru-RU") +
        " байт. Изображения повреждены или не пара к друг другу.",
    );
  }

  // 3. Читаем заголовок вместе с текстом, отбрасываем заголовок, собираем байты.
  var bits = readBits(originalData, encryptedData, neededChannels);
  var bytes = bitsToBytes(bits, HEADER_BITS);

  // 4. Байты -> текст UTF-8.
  try {
    return bytesToText(bytes);
  } catch (error) {
    throw new Error(
      "Сообщение невозможно расшифровать: прочитанные байты не являются корректным текстом UTF-8. " +
        "Проверьте, что исходное изображение действительно то, и что зашифрованное сохранено в PNG.",
    );
  }
}

/* [PURE-END] */

/* ============================================================================
 *  ЧАСТЬ 2. ИНТЕРФЕЙС, ФАЙЛЫ, CANVAS
 * ========================================================================== */

/** Краткий доступ к элементам страницы по id. */
function el(id) {
  return document.getElementById(id);
}

var els = {
  // вкладки
  tabEncode: el("tab-encode"),
  tabDecode: el("tab-decode"),
  panelEncode: el("panel-encode"),
  panelDecode: el("panel-decode"),

  // шифрование
  textInput: el("text-input"),
  textSize: el("text-size"),
  dropEncode: el("drop-encode"),
  dropEncodeText: el("drop-encode-text"),
  previewEncode: el("preview-encode"),
  inputEncode: el("input-encode"),
  btnPickEncode: el("btn-pick-encode"),
  fileEncode: el("file-encode"),
  infoSize: el("info-size"),
  infoCapacity: el("info-capacity"),
  infoText: el("info-text"),
  infoStatus: el("info-status"),
  btnEncode: el("btn-encode"),
  msgEncode: el("msg-encode"),
  resultEncodeCard: el("result-encode-card"),
  previewResult: el("preview-result"),
  resultStats: el("result-stats"),
  btnSave: el("btn-save"),
  btnResetEncode: el("btn-reset-encode"),

  // дешифрование
  dropOriginal: el("drop-original"),
  dropOriginalText: el("drop-original-text"),
  previewOriginal: el("preview-original"),
  inputOriginal: el("input-original"),
  btnPickOriginal: el("btn-pick-original"),
  fileOriginal: el("file-original"),
  infoOriginalSize: el("info-original-size"),
  dropEncrypted: el("drop-encrypted"),
  dropEncryptedText: el("drop-encrypted-text"),
  previewEncrypted: el("preview-encrypted"),
  inputEncrypted: el("input-encrypted"),
  btnPickEncrypted: el("btn-pick-encrypted"),
  fileEncrypted: el("file-encrypted"),
  infoEncryptedSize: el("info-encrypted-size"),
  infoSizes: el("info-sizes"),
  btnDecode: el("btn-decode"),
  msgDecode: el("msg-decode"),
  resultDecode: el("result-decode"),
  resultText: el("result-text"),
  resultMeta: el("result-meta"),
  btnCopy: el("btn-copy"),
};

/** Состояние вкладки «Шифрование». */
var encodeState = {
  image: null, // HTMLImageElement
  imageData: null, // ImageData исходного изображения
  dataUrl: null, // data URL результата (PNG)
  width: 0,
  height: 0,
};

/** Состояние вкладки «Дешифрование». */
var decodeState = {
  original: null, // { image, imageData, fileName }
  encrypted: null, // { image, imageData, fileName }
};

/** Offscreen-канвасы: один для чтения пикселей, второй для записи результата. */
var readCanvas = document.createElement("canvas");
var readCtx = readCanvas.getContext("2d", { willReadFrequently: true });

var writeCanvas = document.createElement("canvas");
var writeCtx = writeCanvas.getContext("2d");

/* ------------------------------------------------------------- мелкие утилиты */

/** Русская плюрализация: 1 байт / 2 байта / 5 байтов. */
function plural(count, one, few, many) {
  var mod10 = count % 10;
  var mod100 = count % 100;

  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/** "12345" -> "12 345 байт" */
function formatBytes(count) {
  var word = count === 0 ? "байт" : plural(count, "байт", "байта", "байтов");
  return count.toLocaleString("ru-RU") + " " + word;
}

/** "12345" -> "12 345" */
function formatNumber(count) {
  return count.toLocaleString("ru-RU");
}

/**
 * Показать сообщение в интерфейсе.
 * @param {HTMLElement} box
 * @param {"error"|"ok"|"info"} type
 * @param {string} text
 */
function showMessage(box, type, text) {
  box.hidden = false;
  box.className = "msg msg--" + type;
  box.textContent = text;
}

function hideMessage(box) {
  box.hidden = true;
  box.className = "msg";
  box.textContent = "";
}

/** Установить подпись статуса ("Достаточно места" и т. п.). */
function setStatus(node, text, type) {
  node.textContent = text;
  node.className = "status" + (type ? " status--" + type : "");
}

/* ------------------------------------------------------- загрузка файлов */

/**
 * Прочитать выбранный файл и превратить его в <img>.
 * Читаем через FileReader и data URL, чтобы Canvas не «портился» (tainted canvas)
 * при открытии страницы просто двойным кликом по index.html.
 * @param {File} file
 * @returns {Promise<{image: HTMLImageElement, dataUrl: string}>}
 */
function loadImage(file) {
  return new Promise(function (resolve, reject) {
    if (!file) {
      reject(new Error("Файл не выбран."));
      return;
    }

    if (file.type && file.type.indexOf("image/") !== 0) {
      reject(new Error("Файл «" + file.name + "» не является изображением."));
      return;
    }

    var reader = new FileReader();

    reader.onerror = function () {
      reject(
        new Error(
          "Не удалось прочитать файл «" +
            file.name +
            "». Возможно, он занят другой программой или к нему нет доступа.",
        ),
      );
    };

    reader.onload = function () {
      var image = new Image();

      image.onload = function () {
        if (!image.naturalWidth || !image.naturalHeight) {
          reject(
            new Error(
              "Изображение «" +
                file.name +
                "» повреждено: у него нет пикселей.",
            ),
          );
          return;
        }
        resolve({ image: image, dataUrl: String(reader.result) });
      };

      image.onerror = function () {
        reject(
          new Error(
            "Изображение «" +
              file.name +
              "» повреждено или браузер не умеет его открывать.",
          ),
        );
      };

      image.src = reader.result;
    };

    reader.readAsDataURL(file);
  });
}

/**
 * Нарисовать изображение на canvas и вернуть его пиксели.
 * @param {HTMLImageElement} image
 * @returns {ImageData}
 */
function extractImageData(image) {
  readCanvas.width = image.naturalWidth;
  readCanvas.height = image.naturalHeight;

  readCtx.clearRect(0, 0, readCanvas.width, readCanvas.height);
  readCtx.drawImage(image, 0, 0);

  try {
    return readCtx.getImageData(0, 0, readCanvas.width, readCanvas.height);
  } catch (error) {
    throw new Error(
      "Браузер не дал прочитать пиксели изображения (Canvas защищён от чтения).",
    );
  }
}

/**
 * Сколько пикселей имеют прозрачность (A < 255).
 * Такие пиксели браузер может рисовать с изменёнными R, G, B,
 * поэтому скрытый текст в них может считываться неверно.
 * @param {ImageData} imageData
 * @returns {number}
 */
function countTransparentPixels(imageData) {
  var count = 0;

  for (var i = 3; i < imageData.data.length; i += 4) {
    if (imageData.data[i] < 255) count++;
  }

  return count;
}

/**
 * Предупредить пользователя, если изображение прозрачное.
 * @param {ImageData} imageData
 * @param {string} fileName
 * @param {HTMLElement} box
 */
function warnAboutTransparency(imageData, fileName, box) {
  var transparent = countTransparentPixels(imageData);

  if (transparent > 0) {
    showMessage(
      box,
      "info",
      "Внимание: в файле «" +
        fileName +
        "» найдено " +
        formatNumber(transparent) +
        " полупрозрачных или полностью прозрачных пикселей. Браузер меняет их значения RGB при отрисовке, " +
        "поэтому скрытый текст может считываться с ошибкой. Лучше всего работают изображения без прозрачности.",
    );
  }
}

/**
 * Показать превью в зоне загрузки.
 */
function showPreview(imgNode, textNode, fileNode, dataUrl, fileName, sizeNode) {
  imgNode.src = dataUrl;
  imgNode.hidden = false;
  textNode.hidden = true;
  fileNode.textContent = "Файл: " + fileName;
  if (sizeNode) sizeNode.textContent = "—";
}

function clearPreview(imgNode, textNode, fileNode, sizeNode) {
  imgNode.hidden = true;
  imgNode.removeAttribute("src");
  textNode.hidden = false;
  fileNode.innerHTML = "&nbsp;";
  if (sizeNode) sizeNode.textContent = "—";
}

/**
 * Привязать кнопку + зону перетаскивания к одному <input type="file">.
 * @param {HTMLElement} zone
 * @param {HTMLInputElement} input
 * @param {(file: File) => void} onFile
 */
function setupDropzone(zone, input, onFile) {
  input.addEventListener("change", function () {
    var file = input.files && input.files[0];
    if (file) onFile(file);
    input.value = ""; // чтобы можно было выбрать тот же файл повторно
  });

  ["dragenter", "dragover"].forEach(function (type) {
    zone.addEventListener(type, function (event) {
      event.preventDefault();
      zone.classList.add("is-over");
    });
  });

  ["dragleave", "dragend", "drop"].forEach(function (type) {
    zone.addEventListener(type, function (event) {
      event.preventDefault();
      zone.classList.remove("is-over");
    });
  });

  zone.addEventListener("drop", function (event) {
    var file =
      event.dataTransfer &&
      event.dataTransfer.files &&
      event.dataTransfer.files[0];
    if (file) onFile(file);
  });

  // Клик по зоне открывает окно выбора файла.
  zone.addEventListener("click", function () {
    input.click();
  });
}

/* ============================================================================
 *  ВКЛАДКА «ШИФРОВАНИЕ»
 * ========================================================================== */

/** Пересчитать всю информацию в правой колонке (ёмкость, размер текста, статус). */
function updateEncodeInfo() {
  var text = els.textInput.value;
  var textBytes = textToBytes(text).length;

  els.textSize.textContent = formatBytes(textBytes);
  els.infoText.textContent = formatBytes(textBytes);

  if (!encodeState.image) {
    els.infoSize.textContent = "—";
    els.infoCapacity.textContent = "—";
    setStatus(els.infoStatus, "Изображение не выбрано", "warn");
    return;
  }

  var capacity = calculateCapacity(encodeState.width, encodeState.height);

  els.infoSize.textContent = encodeState.width + " × " + encodeState.height;
  els.infoCapacity.textContent =
    formatBytes(capacity.maxTextBytes) +
    " (" +
    formatNumber(capacity.totalBits) +
    " бит всего)";

  if (text.length === 0) {
    setStatus(els.infoStatus, "Введите текст", "warn");
  } else if (textBytes > capacity.maxTextBytes) {
    setStatus(els.infoStatus, "Недостаточно места", "error");
  } else {
    setStatus(els.infoStatus, "Достаточно места", "ok");
  }
}

/** Обработчик выбора исходного изображения для шифрования. */
function onEncodeFileSelected(file) {
  hideMessage(els.msgEncode);

  loadImage(file)
    .then(function (result) {
      encodeState.image = result.image;
      encodeState.width = result.image.naturalWidth;
      encodeState.height = result.image.naturalHeight;
      encodeState.imageData = extractImageData(result.image);
      encodeState.dataUrl = null;

      showPreview(
        els.previewEncode,
        els.dropEncodeText,
        els.fileEncode,
        result.dataUrl,
        file.name,
      );
      els.resultEncodeCard.hidden = true;

      warnAboutTransparency(encodeState.imageData, file.name, els.msgEncode);
      updateEncodeInfo();
    })
    .catch(function (error) {
      showMessage(els.msgEncode, "error", error.message);
    });
}

/** Нажатие «Зашифровать». */
function onEncodeClick() {
  hideMessage(els.msgEncode);
  els.resultEncodeCard.hidden = true;
  encodeState.dataUrl = null;

  var text = els.textInput.value;

  // Проверки, о которых просил пользователь.
  if (text.length === 0) {
    showMessage(
      els.msgEncode,
      "error",
      "Ошибка: текст не введён. Введите сообщение в поле «Текст для шифрования».",
    );
    return;
  }

  if (!encodeState.image || !encodeState.imageData) {
    showMessage(
      els.msgEncode,
      "error",
      "Ошибка: изображение не выбрано. Выберите исходное изображение.",
    );
    return;
  }

  var capacity = calculateCapacity(encodeState.width, encodeState.height);
  var textBytes = textToBytes(text).length;

  if (textBytes > capacity.maxTextBytes) {
    showMessage(
      els.msgEncode,
      "error",
      "Ошибка: текст слишком большой.\n" +
        "Размер сообщения — " +
        formatBytes(textBytes) +
        ", а в изображение " +
        encodeState.width +
        " × " +
        encodeState.height +
        " помещается только " +
        formatBytes(capacity.maxTextBytes) +
        " (32 бита занимает заголовок).\n" +
        "Возьмите изображение большего размера или сократите текст.",
    );
    return;
  }

  var result;
  try {
    // Текст -> биты (вместе с 32-битным заголовком) -> пиксели.
    var bits = buildBitStream(text);
    result = encodeMessage(
      encodeState.imageData.data,
      encodeState.width,
      encodeState.height,
      bits,
    );
  } catch (error) {
    showMessage(els.msgEncode, "error", "Ошибка: " + error.message);
    return;
  }

  // Рисуем новые пиксели на canvas и получаем PNG.
  try {
    writeCanvas.width = encodeState.width;
    writeCanvas.height = encodeState.height;

    var out = writeCtx.createImageData(encodeState.width, encodeState.height);
    out.data.set(result.data);
    writeCtx.putImageData(out, 0, 0);

    encodeState.dataUrl = writeCanvas.toDataURL("image/png");
  } catch (error) {
    showMessage(
      els.msgEncode,
      "error",
      "Ошибка: не удалось создать PNG-изображение. " + error.message,
    );
    return;
  }

  els.previewResult.src = encodeState.dataUrl;
  els.resultStats.innerHTML =
    "Записано <b>" +
    formatNumber(result.usedChannels) +
    "</b> бит (" +
    formatNumber(result.usedChannels - HEADER_BITS) +
    " бит текста), изменено каналов: <b>" +
    formatNumber(result.changedChannels) +
    "</b> из " +
    formatNumber(result.totalChannels) +
    ". Сообщение: <b>" +
    formatBytes(textBytes) +
    "</b>.";
  els.resultEncodeCard.hidden = false;

  showMessage(
    els.msgEncode,
    "ok",
    "Готово: текст скрыт в изображении. Сохраните результат в PNG.",
  );
  els.resultEncodeCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** Нажатие «Сохранить изображение». */
function onSaveClick() {
  hideMessage(els.msgEncode);

  if (!encodeState.dataUrl) {
    showMessage(
      els.msgEncode,
      "error",
      "Ошибка: сначала нажмите «Зашифровать».",
    );
    return;
  }

  var link = document.createElement("a");
  link.href = encodeState.dataUrl;
  link.download = "encrypted.png";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  showMessage(
    els.msgEncode,
    "ok",
    "Файл encrypted.png сохранён. Не пересохраняйте его в JPEG.",
  );
}

/** Сброс вкладки «Шифрование». */
function onResetEncode() {
  els.textInput.value = "";
  encodeState.image = null;
  encodeState.imageData = null;
  encodeState.dataUrl = null;
  encodeState.width = 0;
  encodeState.height = 0;

  clearPreview(els.previewEncode, els.dropEncodeText, els.fileEncode);
  els.resultEncodeCard.hidden = true;
  hideMessage(els.msgEncode);
  updateEncodeInfo();
}

/* ============================================================================
 *  ВКЛАДКА «ДЕШИФРОВАНИЕ»
 * ========================================================================== */

/** Проверка пары изображений и подпись под кнопкой. */
function updateDecodeInfo() {
  var original = decodeState.original;
  var encrypted = decodeState.encrypted;

  els.infoOriginalSize.textContent = original
    ? original.image.naturalWidth + " × " + original.image.naturalHeight
    : "—";
  els.infoEncryptedSize.textContent = encrypted
    ? encrypted.image.naturalWidth + " × " + encrypted.image.naturalHeight
    : "—";

  if (!original && !encrypted) {
    setStatus(els.infoSizes, "Загрузите оба изображения", "warn");
    return;
  }

  if (!original || !encrypted) {
    setStatus(els.infoSizes, "Загрузите второе изображение", "warn");
    return;
  }

  var sameSize =
    original.image.naturalWidth === encrypted.image.naturalWidth &&
    original.image.naturalHeight === encrypted.image.naturalHeight;

  if (!sameSize) {
    setStatus(els.infoSizes, "Размеры не совпадают", "error");
  } else {
    setStatus(
      els.infoSizes,
      "Размеры совпадают: " +
        original.image.naturalWidth +
        " × " +
        original.image.naturalHeight,
      "ok",
    );
  }
}

/** Обработчик выбора исходного изображения. */
function onOriginalFileSelected(file) {
  hideMessage(els.msgDecode);

  loadImage(file)
    .then(function (result) {
      decodeState.original = {
        image: result.image,
        imageData: extractImageData(result.image),
        fileName: file.name,
      };

      showPreview(
        els.previewOriginal,
        els.dropOriginalText,
        els.fileOriginal,
        result.dataUrl,
        file.name,
      );
      els.resultDecode.hidden = true;
      warnAboutTransparency(
        decodeState.original.imageData,
        file.name,
        els.msgDecode,
      );
      updateDecodeInfo();
    })
    .catch(function (error) {
      showMessage(els.msgDecode, "error", error.message);
    });
}

/** Обработчик выбора зашифрованного изображения. */
function onEncryptedFileSelected(file) {
  hideMessage(els.msgDecode);

  loadImage(file)
    .then(function (result) {
      decodeState.encrypted = {
        image: result.image,
        imageData: extractImageData(result.image),
        fileName: file.name,
      };

      showPreview(
        els.previewEncrypted,
        els.dropEncryptedText,
        els.fileEncrypted,
        result.dataUrl,
        file.name,
      );
      els.resultDecode.hidden = true;
      warnAboutTransparency(
        decodeState.encrypted.imageData,
        file.name,
        els.msgDecode,
      );
      updateDecodeInfo();
    })
    .catch(function (error) {
      showMessage(els.msgDecode, "error", error.message);
    });
}

/** Нажатие «Расшифровать». */
function onDecodeClick() {
  hideMessage(els.msgDecode);
  els.resultDecode.hidden = true;

  // 1. Оба изображения загружены.
  if (!decodeState.original || !decodeState.encrypted) {
    showMessage(
      els.msgDecode,
      "error",
      "Ошибка: загрузите оба изображения — нужны и исходное, и зашифрованное.",
    );
    return;
  }

  var original = decodeState.original;
  var encrypted = decodeState.encrypted;

  // 2. Размеры изображений совпадают.
  if (
    original.image.naturalWidth !== encrypted.image.naturalWidth ||
    original.image.naturalHeight !== encrypted.image.naturalHeight
  ) {
    showMessage(
      els.msgDecode,
      "error",
      "Ошибка: исходное и зашифрованное изображения должны иметь одинаковый размер.\n" +
        "Исходное: " +
        original.image.naturalWidth +
        " × " +
        original.image.naturalHeight +
        ", зашифрованное: " +
        encrypted.image.naturalWidth +
        " × " +
        encrypted.image.naturalHeight +
        ".",
    );
    updateDecodeInfo();
    return;
  }

  // 3. Пиксели прочитаны, размеры canvas совпадают (размер пикселей = размер изображений).
  if (!original.imageData || !encrypted.imageData) {
    showMessage(
      els.msgDecode,
      "error",
      "Ошибка: не удалось прочитать пиксели одного из изображений.",
    );
    return;
  }

  if (
    original.imageData.width !== encrypted.imageData.width ||
    original.imageData.height !== encrypted.imageData.height
  ) {
    showMessage(els.msgDecode, "error", "Ошибка: размеры Canvas не совпадают.");
    return;
  }

  // 4. Собственно дешифрование.
  try {
    var text = decodeMessage(original.imageData.data, encrypted.imageData.data);
    var byteLength = textToBytes(text).length;

    els.resultText.value = text;
    els.resultMeta.innerHTML =
      "Размер сообщения: <b>" +
      formatBytes(byteLength) +
      "</b>. " +
      "Символов: <b>" +
      formatNumber(text.length) +
      "</b>.";
    els.resultDecode.hidden = false;

    showMessage(els.msgDecode, "ok", "Готово: текст восстановлен.");
    els.resultDecode.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    setStatus(els.infoSizes, "Не удалось расшифровать", "error");
    showMessage(els.msgDecode, "error", "Ошибка: " + error.message);
  }
}

/** Нажатие «Копировать текст». */
function onCopyClick() {
  var text = els.resultText.value;

  if (!text) {
    showMessage(
      els.msgDecode,
      "error",
      "Нечего копировать — текст не расшифрован.",
    );
    return;
  }

  // Clipboard API есть не во всех браузерах (и не при открытии файла с диска),
  // поэтому предусмотрен запасной способ через выделение текста.
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard
      .writeText(text)
      .then(function () {
        showMessage(els.msgDecode, "ok", "Текст скопирован в буфер обмена.");
      })
      .catch(function () {
        copyBySelection();
      });
  } else {
    copyBySelection();
  }

  function copyBySelection() {
    try {
      els.resultText.select();
      els.resultText.setSelectionRange(0, text.length);
      var ok = document.execCommand("copy");

      if (ok) {
        showMessage(els.msgDecode, "ok", "Текст скопирован в буфер обмена.");
      } else {
        throw new Error("execCommand вернул false");
      }
    } catch (error) {
      showMessage(
        els.msgDecode,
        "info",
        "Браузер не разрешил копирование. Текст выделен — нажмите Ctrl+C (Cmd+C на Mac).",
      );
    }
  }
}

/* ============================================================================
 *  ПЕРЕКЛЮЧЕНИЕ ВКЛАДОК И ИНИЦИАЛИЗАЦИЯ
 * ========================================================================== */

function activateTab(tab) {
  var isEncode = tab === "encode";

  els.tabEncode.classList.toggle("is-active", isEncode);
  els.tabDecode.classList.toggle("is-active", !isEncode);
  els.tabEncode.setAttribute("aria-selected", isEncode ? "true" : "false");
  els.tabDecode.setAttribute("aria-selected", !isEncode ? "true" : "false");

  els.panelEncode.classList.toggle("is-hidden", !isEncode);
  els.panelDecode.classList.toggle("is-hidden", isEncode);
}

function init() {
  // Вкладки.
  els.tabEncode.addEventListener("click", function () {
    activateTab("encode");
  });
  els.tabDecode.addEventListener("click", function () {
    activateTab("decode");
  });

  // Шифрование.
  setupDropzone(els.dropEncode, els.inputEncode, onEncodeFileSelected);
  els.btnPickEncode.addEventListener("click", function () {
    els.inputEncode.click();
  });
  els.textInput.addEventListener("input", updateEncodeInfo);
  els.btnEncode.addEventListener("click", onEncodeClick);
  els.btnSave.addEventListener("click", onSaveClick);
  els.btnResetEncode.addEventListener("click", onResetEncode);

  // Дешифрование.
  setupDropzone(els.dropOriginal, els.inputOriginal, onOriginalFileSelected);
  setupDropzone(els.dropEncrypted, els.inputEncrypted, onEncryptedFileSelected);
  els.btnPickOriginal.addEventListener("click", function () {
    els.inputOriginal.click();
  });
  els.btnPickEncrypted.addEventListener("click", function () {
    els.inputEncrypted.click();
  });
  els.btnDecode.addEventListener("click", onDecodeClick);
  els.btnCopy.addEventListener("click", onCopyClick);

  updateEncodeInfo();
  updateDecodeInfo();
}

init();
