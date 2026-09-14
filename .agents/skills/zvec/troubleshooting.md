# Troubleshooting

## Common Issues and Solutions

### Insert Failures

| Issue | Possible Cause | Solution |
|-------|---------------|----------|
| Dimension mismatch | Vector dimension doesn't match Schema definition | Check `dimension` parameter and actual vector length |
| ID already exists | Duplicate id when using insert | Use upsert instead, or check id uniqueness |
| Type error | Field value doesn't match DataType | Check field type definition and assignment |

### Query Issues

| Issue | Possible Cause | Solution |
|-------|---------------|----------|
| Empty results | Vector index not created | Ensure `index_param` is defined in Schema |
| Inaccurate results | ANN approximation error | Increase HNSW `ef` parameter or use FLAT |
| Slow filter query | Scalar field not indexed | Add `InvertIndexParam` to filter fields |
| Missing output fields | output_fields not specified | Add `output_fields` parameter in query |

### Performance Issues

| Issue | Possible Cause | Solution |
|-------|---------------|----------|
| High memory usage | HNSW parameters too large | Reduce `M` or use IVF index |
| Slow query speed | Large data volume not optimized | Call `optimize()` after large batch writes |
| Slow write speed | Single insert operations | Use batch insert (array form) |
| Disk space growth | Not flushed in time | Call `flush()` periodically |

### Index Issues

| Issue | Possible Cause | Solution |
|-------|---------------|----------|
| Index creation failed | Field type not supported | Check if field type supports indexing |
| Slow range query | Range optimization not enabled | Use `InvertIndexParam(enable_range_optimization=True)` |
| Slow vector search | Wrong index type selected | Choose based on data volume: FLAT(<100k), HNSW(recommended), IVF(>10M) |

## Debugging Tips

### Enable Logging

**Python:**
```python
import zvec
zvec.initialize(log_level=zvec.LogLevel.DEBUG)
```

**Node.js:**
```typescript
import { ZVecInitialize, ZVecLogLevel } from "@zvec/zvec";
ZVecInitialize({ logLevel: ZVecLogLevel.DEBUG });
```

### Check Collection Status

```python
# Python
print(collection.stats)
print(collection.schema)
```

```typescript
// Node.js
console.log(collection.stats);
console.log(collection.schema);
```

### Validate Data

```python
# Fetch single document for validation
doc = collection.fetch("doc_id")
print(doc.vectors)
print(doc.fields)
```

## Best Practices

1. **Batch operations**: Use batch insert/upsert whenever possible
2. **Optimize timely**: Call `optimize()` after large batch writes
3. **Proper indexing**: Create indexes for frequently filtered fields
4. **Monitor memory**: Watch HNSW index memory usage
5. **Regular backup**: Backup Collection directory regularly for important data
