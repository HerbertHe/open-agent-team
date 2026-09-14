# Embedding

Zvec's embedding function system converts text into vector representations for similarity search. It provides multiple out-of-the-box implementations and supports custom extensions.

**Current Support:** Zvec currently supports text modality embeddings only.

**Dependencies:**
```bash
pip install openai dashscope dashtext sentence-transformers
```

## Embedding Function Types

| Type | Implementation | Description |
|------|----------------|-------------|
| **Local Dense** | `DefaultLocalDenseEmbedding` | Uses Sentence Transformers with all-MiniLM-L6-v2 model (384 dimensions, ~80MB) |
| **Local Sparse** | `DefaultLocalSparseEmbedding` | Uses SPLADE model (~100MB) |
| **BM25** | `BM25EmbeddingFunction` | BM25 algorithm using DashText SDK (local computation, no API key needed) |
| **Qwen Dense** | `QwenDenseEmbedding` | Uses Qwen Dashscope API |
| **Qwen Sparse** | `QwenSparseEmbedding` | Uses Qwen Dashscope API |
| **OpenAI Dense** | `OpenAIDenseEmbedding` | Uses OpenAI API |
| **Jina Dense** | `JinaDenseEmbedding` | Uses Jina Embeddings API with task-specific and Matryoshka dimension support |

## Dense Embedding

Dense embeddings capture semantic meaning in fixed-length continuous vectors.

### 1. DefaultLocalDenseEmbedding - Local Dense Embedding

Uses the Sentence Transformers library with the all-MiniLM-L6-v2 model to generate 384-dimensional dense vectors.

**Model Details:**
- Model: all-MiniLM-L6-v2 (HuggingFace) or iic/nlp_gte_sentence-embedding_chinese-small (ModelScope for Chinese)
- Dimensions: 384
- Size: ~80MB

```python
from zvec.extension import DefaultLocalDenseEmbedding

# Basic usage (international users)
embedding_func = DefaultLocalDenseEmbedding()
vector = embedding_func.embed("Hello, world!")
print(f"Dimensions: {len(vector)}")  # 384

# Chinese users: recommended to use ModelScope
embedding_func = DefaultLocalDenseEmbedding(model_source="modelscope")
vector = embedding_func.embed("你好，世界！")

# Batch processing
texts = ["Text 1", "Text 2", "Text 3"]
vectors = [embedding_func.embed(text) for text in texts]

# Semantic similarity computation
import numpy as np
v1 = embedding_func.embed("The cat sits on the mat")
v2 = embedding_func.embed("A cat is resting on the mat")
similarity = np.dot(v1, v2)  # Normalized vectors, dot product = cosine similarity
print(f"Similarity: {similarity:.4f}")
```

### 2. QwenDenseEmbedding - Dashscope API Dense Embedding

Uses Qwen's Dashscope embedding API.

**Note:** Requires Dashscope API key, and dimension must be specified explicitly.

```python
from zvec.extension import QwenDenseEmbedding

embedding_func = QwenDenseEmbedding(
    api_key="your-dashscope-api-key",
    model="text-embedding-v4",   # Optional, uses latest model by default
    dimension=256,               # Required: embedding dimension
)

vector = embedding_func.embed("Vector database")
print(f"Dimensions: {embedding_func.dimension}")  # 256
```

### 3. OpenAIDenseEmbedding - OpenAI API Dense Embedding

Uses OpenAI's embedding API.

```python
from zvec.extension import OpenAIDenseEmbedding

embedding_func = OpenAIDenseEmbedding(
    api_key="your-openai-api-key",
    model="text-embedding-4",  # Optional, uses latest model by default
    dimension=256,            # Required: embedding dimension
)

vector = embedding_func.embed("Vector database")
```

### 4. JinaDenseEmbedding - Jina Embeddings API Dense Embedding

Uses the Jina Embeddings API to generate dense vectors. Supports task-specific embeddings and Matryoshka representation learning.

**Available Models:**

| Model | Parameters | Max Length | Dimensions | MTEB English v2 |
|-------|------------|------------|------------|-----------------|
| jina-embeddings-v5-text-small | 677M | 32768 | 1024 | 71.7 |
| jina-embeddings-v5-text-nano | 239M | 8192 | 768 | 71.0 |

```python
from zvec.extension import JinaDenseEmbedding

# Basic usage (default: v5-text-small, 1024 dimensions)
embedding_func = JinaDenseEmbedding(api_key="your-jina-api-key")
vector = embedding_func.embed("Vector database")
print(f"Dimensions: {len(vector)}")  # 1024

# For retrieval: use different task types for queries vs documents
query_emb = JinaDenseEmbedding(
    api_key="your-jina-api-key",
    task="retrieval.query",
)
doc_emb = JinaDenseEmbedding(
    api_key="your-jina-api-key",
    task="retrieval.passage",
)

query_vector = query_emb.embed("What is machine learning?")
doc_vector = doc_emb.embed("Machine learning is a subset of artificial intelligence...")

# With Matryoshka dimension reduction
emb = JinaDenseEmbedding(
    api_key="your-jina-api-key",
    model="jina-embeddings-v5-text-small",
    dimension=256,
    task="text-matching",
)
vector = emb.embed("Compact 256-dim vector")
print(f"Dimensions: {len(vector)}")  # 256
```

**Supported Tasks:**

| Task | Use Case |
|------|----------|
| `retrieval.query` | Encode search queries for retrieval |
| `retrieval.passage` | Encode documents/passages for retrieval |
| `text-matching` | Symmetric similarity (e.g., duplicate detection) |
| `classification` | Encode text for classification tasks |
| `separation` | Encode text for clustering/topic separation |

## Sparse Embedding

Sparse embeddings represent text with high-dimensional sparse vectors, ideal for lexical matching.

### 1. DefaultLocalSparseEmbedding - Local Sparse Embedding

Uses the SPLADE model to generate sparse vectors.

**Model Details:**
- Model: naver/splade-cocondenser-ensembledistil
- Size: ~100MB
- Output: Sparse dictionary format

```python
from zvec.extension import DefaultLocalSparseEmbedding

# Query embedding (for search queries)
query_embedding = DefaultLocalSparseEmbedding(encoding_type="query")
query_vec = query_embedding.embed("machine learning algorithms")

# Document embedding (for document indexing)
doc_embedding = DefaultLocalSparseEmbedding(encoding_type="document")
doc_vec = doc_embedding.embed("Machine learning is a subfield of artificial intelligence")

# Sparse vector format: {dimension_index: weight}
print(f"Non-zero dimensions: {len(query_vec)}")
print(f"First 5 dimensions: {list(query_vec.items())[:5]}")

# Clear model cache
DefaultLocalSparseEmbedding.clear_cache()
```

### 2. BM25EmbeddingFunction - DashText SDK BM25 Sparse Embedding

Uses DashText's local BM25 encoder for lexical matching. No API key required.

```python
from zvec.extension import BM25EmbeddingFunction

# Option 1: Using built-in encoder (no corpus needed)
# For Chinese query encoding
bm25_query_zh = BM25EmbeddingFunction(language="zh", encoding_type="query")
query_vec = bm25_query_zh.embed("深度学习神经网络")

# For Chinese document encoding
bm25_doc_zh = BM25EmbeddingFunction(language="zh", encoding_type="document")
doc_vec = bm25_doc_zh.embed("机器学习是人工智能的重要分支")

# For English query encoding
bm25_query_en = BM25EmbeddingFunction(language="en", encoding_type="query")
query_vec_en = bm25_query_en.embed("deep learning neural networks")

# Option 2: Using custom corpus for better domain accuracy
corpus = [
    "Machine learning is an important branch of artificial intelligence",
    "Deep learning uses neural networks",
    "Natural language processing handles text data"
]

bm25_custom = BM25EmbeddingFunction(
    corpus=corpus,
    encoding_type="query",
    b=0.75,   # Document length normalization
    k1=1.2    # Term frequency saturation
)

query_vec = bm25_custom.embed("deep learning neural networks")
```

### 3. QwenSparseEmbedding - Dashscope API Sparse Embedding

Requires Dashscope API key.

```python
from zvec.extension import QwenSparseEmbedding

embedding_func = QwenSparseEmbedding(
    api_key="your-dashscope-api-key",
    dimension=256,  # Required: embedding dimension
)
sparse_vec = embedding_func.embed("sparse vector")
```

## Custom Implementation

Create your own embedding functions by implementing the protocol base classes:

- `DenseEmbeddingFunction[T]`: Protocol for dense embeddings
- `SparseEmbeddingFunction[T]`: Protocol for sparse embeddings
