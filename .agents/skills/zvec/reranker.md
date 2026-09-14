# Reranker

Zvec's reranking function system re-orders retrieval results to improve relevance and accuracy. It provides multiple out-of-the-box implementations and supports custom extensions.

**Dependencies:**
```bash
pip install openai dashscope sentence-transformers
```

## Reranking Function Types

| Type | Implementation | Description |
|------|----------------|-------------|
| **Local Reranking** | `DefaultLocalReRanker` | Uses Cross-Encoder cross-encoder/ms-marco-MiniLM-L6-v2 model (~80MB) |
| **Qwen Reranking** | `QwenReRanker` | Uses Qwen Dashscope API |
| **RRF Reranking** | `RrfReRanker` | Reciprocal Rank Fusion for multi-vector retrieval results |
| **Weighted Reranking** | `WeightedReRanker` | Weighted fusion for multi-vector retrieval results |

## Local Reranking

### DefaultLocalReRanker - Local Cross-Encoder Reranking

Uses a Cross-Encoder model for reranking.

**Model Details:**
- Model: cross-encoder/ms-marco-MiniLM-L6-v2
- Size: ~80MB

```python
from zvec.extension import DefaultLocalReRanker
from zvec import Doc

# Initialize reranker
reranker = DefaultLocalReRanker(
    query="What are machine learning algorithms",
    topn=5,
    rerank_field="content"  # Specify the field to rerank
)

# Prepare document list
documents = {
    "vector1": [
        Doc(
            id="1",
            fields={
                "content": "Machine learning is a subset of artificial intelligence that focuses on building systems that can learn from data."
            },
        ),
        Doc(
            id="2",
            fields={
                "content": "The weather is nice today with clear skies and sunshine."
            },
        ),
        Doc(
            id="3",
            fields={
                "content": "Deep learning is a specialized branch of machine learning using neural networks with multiple layers."
            },
        ),
    ],
}

# Perform reranking
reranked_docs = reranker.rerank(documents)

for doc in reranked_docs:
    print(doc)
```

## API-Based Reranking

### QwenReRanker - Dashscope API Reranking

Requires Dashscope API key.

```python
from zvec.extension import QwenReRanker
from zvec import Doc

reranker = QwenReRanker(
    query="What is a vector database",
    model="gte-rerank-v2",
    api_key="your-dashscope-api-key",
    topn=3,
    rerank_field="content",
)

documents = {
    "vector1": [
        Doc(
            id="1",
            fields={"content": "Vector databases store and retrieve vectors"},
        ),
        Doc(
            id="2",
            fields={"content": "Relational databases store structured data"},
        ),
        Doc(
            id="3",
            fields={"content": "Vector retrieval is based on similarity computation"},
        ),
    ],
}

# Perform reranking
reranked_docs = reranker.rerank(documents)

for doc in reranked_docs:
    print(doc)
```

## Fusion Reranking

Fusion rerankers are specifically designed for multi-vector retrieval scenarios where you have results from multiple embedding methods (e.g., dense + sparse).

### RrfReRanker - Reciprocal Rank Fusion

Fuses multiple retrieval results using Reciprocal Rank Fusion (RRF).

**Note:** This reranker works with ranking positions only, no scores required.

```python
from zvec.extension import RrfReRanker
from zvec import Doc

# Prepare multiple retrieval results
documents = {
    "vector1": [
        Doc(id="1", score=0.8),
        Doc(id="2", score=0.7),
        Doc(id="3", score=0.75),
    ],
}

reranker = RrfReRanker(topn=3)
# Fuse results
fused_results = reranker.rerank(documents)
```

### WeightedReRanker - Weighted Fusion

Fuses multiple scored retrieval results according to weights.

```python
from zvec.extension import WeightedReRanker
from zvec import Doc

# Prepare multiple retrieval results
documents = {
    "vector1": [
        Doc(id="1", score=0.8),
        Doc(id="2", score=0.7),
        Doc(id="3", score=0.75),
    ],
}

reranker = WeightedReRanker(
    weights=[1.0],  # Weights for each result set
    topn=3
)

# Fuse results
fused_results = reranker.rerank(documents)
print(fused_results)
```

## Using Reranker in Query

Rerankers can be used directly in the `query()` method for multi-vector search:

```python
import zvec

results = collection.query(
    vectors=[
        zvec.VectorQuery(field_name="dense_vec", vector=[0.1] * 768),
        zvec.VectorQuery(field_name="sparse_vec", vector={1: 0.1, 37: 0.43}),
    ],
    reranker=zvec.WeightedReRanker(
        topn=10,
        metric=zvec.MetricType.IP,
        weights={"dense_vec": 1.2, "sparse_vec": 1.0},
    ),
)
```

Or using RRF reranker:

```python
results = collection.query(
    vectors=[
        zvec.VectorQuery(field_name="vec1", vector=[0.1] * 768),
        zvec.VectorQuery(field_name="vec2", vector=[0.2] * 768),
    ],
    reranker=zvec.RRFReRanker(
        topn=10,
        rank_constant=60,
    ),
)
```

## Custom Implementation

Create custom reranking functions by inheriting from the `ReRanker` base class:

```python
from zvec.extension import ReRanker
from typing import List, Dict, Any, Optional


class MyCustomReRanker(ReRanker):
    """Custom reranking function example"""

    def __init__(self, topn: int = 10, model_name: str = "custom-reranker", **kwargs):
        self._topn = topn
        self._model_name = model_name
        self._extra_params = kwargs
        self._model = self._load_model()

    @property
    def topn(self) -> int:
        return self._topn

    @topn.setter
    def topn(self, value: int):
        if value <= 0:
            raise ValueError("topn must be positive")
        self._topn = value

    @property
    def extra_params(self) -> dict:
        return self._extra_params

    def _load_model(self):
        # Implement your model loading logic
        pass

    def rerank(
        self,
        documents: List[Dict[str, Any]],
        query: Optional[str] = None,
        rerank_field: str = "content",
        **kwargs
    ) -> List[Dict[str, Any]]:
        """Rerank documents"""
        if not documents:
            return []

        # Extract content to rerank
        contents = [doc.get(rerank_field, "") for doc in documents]

        # Compute reranking scores using your model
        # scores = self._model.predict(query, contents)

        # Add scores to documents and sort
        scored_docs = []
        for doc, score in zip(documents, scores):
            doc_copy = doc.copy()
            doc_copy["rerank_score"] = score
            scored_docs.append(doc_copy)

        scored_docs.sort(key=lambda x: x["rerank_score"], reverse=True)
        return scored_docs[:self._topn]

    def __call__(self, documents: List[Dict[str, Any]], **kwargs) -> List[Dict[str, Any]]:
        return self.rerank(documents, **kwargs)
```

## Query-Based Reranker Example

```python
from zvec.extension import ReRanker
from typing import List, Dict, Any


class QueryBasedReRanker(ReRanker):
    """Reranker that requires query at initialization"""

    def __init__(self, query: str, topn: int = 10):
        if not query:
            raise ValueError("Query is required")
        self._query = query
        self._topn = topn

    @property
    def query(self) -> str:
        return self._query

    @property
    def topn(self) -> int:
        return self._topn

    @topn.setter
    def topn(self, value: int):
        if value <= 0:
            raise ValueError("topn must be positive")
        self._topn = value

    @property
    def extra_params(self) -> dict:
        return {}

    def rerank(self, documents: List[Dict[str, Any]], rerank_field: str = "content", **kwargs) -> List[Dict[str, Any]]:
        if not documents:
            return []

        scored_docs = []
        for doc in documents:
            content = doc.get(rerank_field, "")
            score = self._compute_relevance(self._query, content)
            doc_copy = doc.copy()
            doc_copy["rerank_score"] = score
            scored_docs.append(doc_copy)

        scored_docs.sort(key=lambda x: x["rerank_score"], reverse=True)
        return scored_docs[:self._topn]

    def _compute_relevance(self, query: str, content: str) -> float:
        # Simple word overlap score
        query_words = set(query.lower().split())
        content_words = set(content.lower().split())
        overlap = len(query_words & content_words)
        return overlap / (len(query_words) + 1e-6)

    def __call__(self, documents: List[Dict[str, Any]], **kwargs) -> List[Dict[str, Any]]:
        return self.rerank(documents, **kwargs)


# Usage
reranker = QueryBasedReRanker(query="machine learning algorithms", topn=3)

documents = [
    {"id": 1, "content": "Machine learning is an important AI algorithm"},
    {"id": 2, "content": "Deep learning uses neural networks"},
    {"id": 3, "content": "Supervised learning is a common ML method"},
]

reranked = reranker.rerank(documents, rerank_field="content")
```
