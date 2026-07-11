<?php
/**
 * 只读文件树 API
 *   GET /api/files.php?root=<abs>&path=<rel>            列目录
 *   GET /api/files.php?root=<abs>&path=<rel>&mode=read  读文件
 *
 * root 缺省时使用 config['workspace_dir']。
 * 出于安全考虑:root 必须是绝对路径且存在,否则回退默认。
 */
header('Content-Type: application/json; charset=utf-8');

$cfg = require __DIR__ . '/../../config/config.php';

function pick_root(array $cfg): string {
    $raw = isset($_GET['root']) ? trim((string)$_GET['root']) : '';
    if ($raw !== '') {
        $raw = str_replace(['/'], DIRECTORY_SEPARATOR, $raw);
        $real = realpath($raw);
        if ($real && is_dir($real)) return $real;
    }
    $default = $cfg['workspace_dir'];
    if (!is_dir($default)) @mkdir($default, 0777, true);
    $real = realpath($default);
    return $real ?: $default;
}

$root = pick_root($cfg);
$rel = $_GET['path'] ?? '';
$rel = str_replace('\\', '/', $rel);
$rel = ltrim($rel, '/');

if (strpos($rel, '..') !== false) {
    http_response_code(400);
    echo json_encode(['error' => 'illegal path'], JSON_UNESCAPED_UNICODE);
    exit;
}

$target = $rel === '' ? $root : realpath($root . DIRECTORY_SEPARATOR . $rel);
if (!$target || strpos($target, $root) !== 0) {
    http_response_code(404);
    echo json_encode(['error' => 'not found', 'root' => $root, 'rel' => $rel], JSON_UNESCAPED_UNICODE);
    exit;
}

$mode = $_GET['mode'] ?? 'list';

if ($mode === 'read' && is_file($target)) {
    $size = filesize($target);
    $max = 200000;
    $content = file_get_contents($target, false, null, 0, $max);
    // 简单的二进制探测:含大量 NUL 则不返回
    $isBinary = strpos(substr((string)$content, 0, 4096), "\0") !== false;
    echo json_encode([
        'root'      => $root,
        'path'      => $rel,
        'size'      => $size,
        'truncated' => $size > $max,
        'binary'    => $isBinary,
        'content'   => $isBinary ? '[binary file, not shown]' : $content,
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

if (!is_dir($target)) {
    http_response_code(400);
    echo json_encode(['error' => 'not a dir'], JSON_UNESCAPED_UNICODE);
    exit;
}

$entries = [];
$dh = @opendir($target);
if ($dh) {
    while (($name = readdir($dh)) !== false) {
        if ($name === '.' || $name === '..') continue;
        $full = $target . DIRECTORY_SEPARATOR . $name;
        $entries[] = [
            'name' => $name,
            'type' => is_dir($full) ? 'dir' : 'file',
            'size' => is_file($full) ? @filesize($full) : null,
        ];
    }
    closedir($dh);
}
usort($entries, function ($a, $b) {
    if ($a['type'] !== $b['type']) return $a['type'] === 'dir' ? -1 : 1;
    return strcasecmp($a['name'], $b['name']);
});

echo json_encode([
    'root'    => $root,
    'path'    => $rel,
    'entries' => $entries,
], JSON_UNESCAPED_UNICODE);
