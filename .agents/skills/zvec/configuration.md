# Zvec Configuration

Before performing any database operations, you can optionally configure global settings using the initialization function.

- If omitted, Zvec automatically applies sensible defaults — typically tuned to your system's available memory, CPU, and environment.
- Call initialization when you need to customize settings, such as:
  - Adjusting log verbosity or output format
  - Controlling concurrency (e.g., query thread count)

Call initialization once, and only at application startup — before any collections are created or opened. It is not intended for runtime reconfiguration.

## Python Configuration

### Basic Usage

```python
import zvec

# Initialize with defaults
zvec.init()

# Initialize with custom settings
zvec.init(
    log_type=zvec.LogType.CONSOLE,
    log_level=zvec.LogLevel.WARN,
    query_threads=4,
)
```

### Configuration Parameters

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `log_type` | `LogType` | Logger destination: `CONSOLE` or `FILE` | `CONSOLE` |
| `log_level` | `LogLevel` | Minimum log severity: `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL` | `WARN` |
| `log_dir` | `str` | Directory for log files (only when `log_type=FILE`) | `"./logs"` |
| `log_basename` | `str` | Base name for rotated log files | `"zvec.log"` |
| `log_file_size` | `int` | Max size per log file in MB before rotation | `2048` (2GB) |
| `log_overdue_days` | `int` | Days to retain rotated log files | `7` |
| `query_threads` | `int` | Number of threads for query execution | Auto-detected |
| `optimize_threads` | `int` | Threads for background tasks (compaction, indexing) | Same as `query_threads` |
| `invert_to_forward_scan_ratio` | `float` | Threshold to switch from inverted index to full scan [0.0, 1.0] | `0.9` |
| `brute_force_by_keys_ratio` | `float` | Threshold to use brute-force over index [0.0, 1.0] | `0.1` |
| `memory_limit_mb` | `int` | Soft memory cap in MB | Auto-detected |

### Configuration Examples

#### Console Logging (Default)

```python
import zvec

zvec.init(
    log_type=zvec.LogType.CONSOLE,
    log_level=zvec.LogLevel.WARN,
    query_threads=4,
)
```

#### File Logging with Rotation

```python
import zvec

zvec.init(
    log_type=zvec.LogType.FILE,
    log_dir="/var/log/zvec",
    log_basename="zvec.log",
    log_file_size=1024,  # 1GB per file
    log_overdue_days=30,
    log_level=zvec.LogLevel.INFO,
)
```

#### Resource Limits

```python
import zvec

zvec.init(
    memory_limit_mb=2048,
    query_threads=4,
    optimize_threads=2,
)
```

#### Query Performance Tuning

```python
import zvec

zvec.init(
    invert_to_forward_scan_ratio=0.95,
    brute_force_by_keys_ratio=0.05,
)
```

## Node.js Configuration

### Basic Usage

```typescript
import { ZVecInitialize, ZVecLogType, ZVecLogLevel } from "@zvec/zvec";

// Initialize with defaults
ZVecInitialize();

// Initialize with custom settings
ZVecInitialize({
  logType: ZVecLogType.CONSOLE,
  logLevel: ZVecLogLevel.WARN,
  queryThreads: 4,
});
```

### Configuration Options

```typescript
interface ZVecInitOptions {
  logType?: ZVecLogType;           // CONSOLE or FILE
  logLevel?: ZVecLogLevel;         // DEBUG, INFO, WARN, ERROR, FATAL
  logDir?: string;                 // Directory for log files
  logBasename?: string;            // Base name for rotated logs
  logFileSize?: number;            // Max size per log file in MB
  logOverdueDays?: number;         // Days to retain rotated logs
  queryThreads?: number;           // Threads for query execution
  optimizeThreads?: number;        // Threads for background tasks
  invertToForwardScanRatio?: number;  // Index to scan threshold
  bruteForceByKeysRatio?: number;     // Brute-force threshold
  memoryLimitMb?: number;          // Soft memory cap in MB
}
```

### Configuration Examples

#### Console Logging (Default)

```typescript
import { ZVecInitialize, ZVecLogType, ZVecLogLevel } from "@zvec/zvec";

ZVecInitialize({
  logType: ZVecLogType.CONSOLE,
  logLevel: ZVecLogLevel.WARN,
  queryThreads: 4,
});
```

#### File Logging with Rotation

```typescript
import { ZVecInitialize, ZVecLogType, ZVecLogLevel } from "@zvec/zvec";

ZVecInitialize({
  logType: ZVecLogType.FILE,
  logDir: "/var/log/zvec",
  logBasename: "zvec.log",
  logFileSize: 1024,
  logOverdueDays: 30,
  logLevel: ZVecLogLevel.INFO,
});
```

## Important Notes

1. **Call Once**: Initialization can only be called once. Subsequent calls will raise a `RuntimeError` (Python) or error (Node.js).

2. **Call Before Any Operation**: Must be called before creating or opening any collections.

3. **Container-Friendly**: When `memory_limit_mb` and thread counts are omitted, Zvec auto-detects based on cgroup limits (e.g., in Docker/Kubernetes).

4. **Log Levels**:
   - `DEBUG`: Detailed debugging information
   - `INFO`: General operational information
   - `WARN`: Warning messages (default)
   - `ERROR`: Error messages
   - `FATAL`: Critical errors only

## Best Practices

1. **Production Logging**: Use `FILE` logging in production with appropriate retention settings
2. **Resource Management**: Explicitly set `memory_limit_mb` and thread counts in containerized environments
3. **Query Tuning**: Adjust `invert_to_forward_scan_ratio` and `brute_force_by_keys_ratio` based on your data characteristics
4. **Development**: Use `CONSOLE` logging with `DEBUG` or `INFO` level during development
