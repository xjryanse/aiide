<?php
/**
 * SSE 中继:把浏览器 POST 转发到 Python /v1/chat/stream
 * 兼容 PHP CLI server / Apache / Nginx-fpm
 */

$cfg = require __DIR__ . '/../../config/config.php';

// ---- 关掉一切输出缓冲,SSE 必须实时 flush ----
@ini_set('output_buffering', '0');
@ini_set('zlib.output_compression', '0');
@ini_set('implicit_flush', '1');
while (ob_get_level() > 0) { @ob_end_clean(); }
ob_implicit_flush(true);
ignore_user_abort(false);
set_time_limit(0);

header('Content-Type: text/event-stream; charset=utf-8');
header('Cache-Control: no-cache, no-transform');
header('X-Accel-Buffering: no');
header('Connection: keep-alive');

function sse_send(string $event, array $data): void {
    echo "event: {$event}\n";
    echo 'data: ' . json_encode($data, JSON_UNESCAPED_UNICODE) . "\n\n";
    @flush();
}

// ---- 读取请求体(兼容多种运行时) ----
$raw = '';
$input = @fopen('php://input', 'rb');
if ($input) {
    while (!feof($input)) {
        $chunk = fread($input, 8192);
        if ($chunk === false) break;
        $raw .= $chunk;
    }
    fclose($input);
}
if ($raw === '' && isset($GLOBALS['HTTP_RAW_POST_DATA'])) {
    $raw = (string)$GLOBALS['HTTP_RAW_POST_DATA'];
}
if ($raw === '' && !empty($_POST)) {
    $raw = json_encode($_POST, JSON_UNESCAPED_UNICODE);
}

if ($raw === '') {
    sse_send('error', [
        'message' => '空请求体',
        'method'  => $_SERVER['REQUEST_METHOD'] ?? '?',
        'ctype'   => $_SERVER['CONTENT_TYPE'] ?? '?',
        'clen'    => $_SERVER['CONTENT_LENGTH'] ?? '?',
    ]);
    exit;
}

// ---- 转发到 Python 后端(流式) ----
$url = rtrim($cfg['agent_base'], '/') . '/v1/chat/stream';

$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $raw,
    CURLOPT_HTTPHEADER     => [
        'Content-Type: application/json',
        'Accept: text/event-stream',
        'Content-Length: ' . strlen($raw),
    ],
    CURLOPT_RETURNTRANSFER => false,
    CURLOPT_HEADER         => false,
    CURLOPT_TIMEOUT        => 0,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_BUFFERSIZE     => 512,     // 越小越接近实时
    CURLOPT_WRITEFUNCTION  => function ($ch, $data) {
        echo $data;
        @flush();
        return strlen($data);
    },
]);

$ok = curl_exec($ch);
if ($ok === false) {
    sse_send('error', ['message' => '无法连接 Agent 服务: ' . curl_error($ch)]);
}
curl_close($ch);
