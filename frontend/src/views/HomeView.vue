<template>
  <div class="home-container">
    <el-row :gutter="20">
      <el-col :span="24">
        <el-card class="welcome-card">
          <template #header>
            <div class="card-header">
              <h2>欢迎使用知识图谱可视化系统</h2>
            </div>
          </template>
          <div class="welcome-content">
            <p>本系统用于展示、查询和管理基于Neo4j的知识图谱数据，支持地理位置信息展示和参数配置。</p>
            <div class="quick-actions">
              <el-button type="warning" @click="navigateTo('/split')">
                <el-icon>
                  <Location />
                </el-icon> 综合视图
              </el-button>
              <el-button type="success" @click="navigateTo('/search')">
                <el-icon>
                  <Search />
                </el-icon> 实体查询
              </el-button>
              <el-button type="info" @click="navigateTo('/import')">
                <el-icon>
                  <Upload />
                </el-icon> 数据导入
              </el-button>
              <el-button type="primary" @click="navigateTo('/evaluation')">
                <el-icon>
                  <DataAnalysis />
                </el-icon> 图谱评估
              </el-button>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="20" class="dashboard-row">
      <el-col :span="12" :xs="24">
        <el-card class="stat-card">
          <template #header>
            <div class="card-header">
              <h3>知识图谱统计</h3>
            </div>
          </template>
          <div class="stat-content" v-loading="loading">
            <div v-if="!loading" class="stat-items-flex">
              <div class="stat-group node-group">
                <div class="stat-group-title">
                  <el-icon class="stat-group-icon node-icon"><UserFilled /></el-icon>
                  节点类型
                </div>
                <div class="stat-items">
                  <div class="stat-item node-item" v-for="(value, key) in stats.nodeState || {}" :key="key">
                    <div class="stat-value">{{ value || 0 }}</div>
                    <div class="stat-label">{{ nodeStateLabels[key] || key }}</div>
                  </div>
                </div>
              </div>
              <div class="stat-group relation-group">
                <div class="stat-group-title">
                  <el-icon class="stat-group-icon relation-icon"><Connection /></el-icon>
                  关系类型
                </div>
                <div class="stat-items">
                  <div class="stat-item relation-item" v-for="(value, key) in stats.relationState || {}" :key="key">
                    <div class="stat-value">{{ value || 0 }}</div>
                    <div class="stat-label">{{ relationStateLabels[key] || key }}</div>
                  </div>
                </div>
              </div>
            </div>
            <div v-else class="no-data">加载中...</div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="12" :xs="24">
        <el-card class="recent-card">
          <template #header>
            <div class="card-header">
              <h3>最近处理的文档</h3>
            </div>
          </template>
          <div class="recent-content" v-loading="loading">
            <el-table v-if="!loading && recentDocuments.length > 0" :data="recentDocuments" style="width: 100%">
              <el-table-column prop="name" label="文档名称" />
              <el-table-column prop="date" label="处理日期" width="180" />
              <el-table-column label="操作" width="120">
                <template #default="scope">
                  <el-button link size="small" @click="viewDocument(scope.row)">查看</el-button>
                </template>
              </el-table-column>
            </el-table>
            <div v-else-if="!loading" class="no-data">暂无最近处理的文档</div>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { getGraphStats, getRecentDocuments, getDocumentDetails } from '../api/homeService';
import { ElMessage } from 'element-plus';

defineOptions({ name: 'HomeView' });

const router = useRouter();
const loading = ref(true);
const stats = ref({});
const recentDocuments = ref([]);
const nodeStateLabels = {
  Attribute: '属性',
  State: '状态',
  Event: '事件',
  Location: '地点',
  Facility: '设施'
};
const relationStateLabels = {
  contain: '包含',
  hasAttribute: '具有属性',
  hasRelation: '具有关系',
  hasState: '具有状态',
  locatedIn: '位于',
  nextState: '下一个状态',
  occurredAt: '发生时间'
};
// 导航到指定路由
const navigateTo = (path) => {
  router.push(path);
};

// 查看文档详情
const viewDocument = async (document) => {
  try {
    const documentId = document.id;
    const details = await getDocumentDetails(documentId);
    // 这里可以添加显示文档详情的逻辑，例如打开一个对话框
    console.log('文档详情:', details);
    // 跳转到文档详情页或打开对话框
    // router.push(`/document/${documentId}`);
  } catch (error) {
    ElMessage.error('获取文档详情失败');
    console.error('获取文档详情失败:', error);
  }
};

// 获取统计数据
const fetchStats = async () => {
  try {
    stats.value = await getGraphStats();
    loading.value = false;
  } catch (error) {
    ElMessage.error('获取统计数据失败');
    console.error('获取统计数据失败:', error);
    loading.value = false;
    // 设置默认值，以防API调用失败
    stats.value = {
      nodeState: {
        Attribute: 0,
        State: 0,
        Event: 0,
        Location: 0,
        Facility: 0
      },
      relationState: {
        contain: 0,
        hasAttribute: 0,
        hasRelation: 0,
        hasState: 0,
        locatedIn: 0,
        nextState: 0,
        occurredAt: 0
      }
    };
  }
};

// 获取最近处理的文档
const fetchRecentDocuments = async () => {
  try {
    recentDocuments.value = await getRecentDocuments();
  } catch (error) {
    ElMessage.error('获取最近文档失败');
    console.error('获取最近文档失败:', error);
    recentDocuments.value = [];
  }
};

onMounted(async () => {
  try {
    // 并行请求数据以提高加载速度
    await Promise.all([fetchStats(), fetchRecentDocuments()]);
  } catch (error) {
    console.error('初始化数据失败:', error);
  }
});
</script>

<style scoped>
.home-container {
  padding: 20px;
}

.dashboard-row {
  margin-top: 20px;
}

.welcome-card {
  margin-bottom: 20px;
}

.stat-card{
  margin-bottom: 20px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.welcome-content {
  text-align: center;
  padding: 20px 0;
}

.quick-actions {
  margin-top: 20px;
  display: flex;
  justify-content: center;
  gap: 15px;
  flex-wrap: wrap;
}

.stat-content,
.recent-content {
  min-height: 200px;
}

.stat-items {
  display: flex;
  justify-content: space-around;
  padding: 20px 0;
}

.stat-item {
  text-align: center;
}

.stat-value {
  font-size: 36px;
  font-weight: bold;
  color: #409EFF;
}

.stat-label {
  margin-top: 10px;
  font-size: 14px;
  color: #606266;
}

.no-data {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 200px;
  color: #909399;
}
.stat-items-flex {
  display: flex;
  gap: 32px;
  justify-content: space-between;
  flex-wrap: wrap;
}
.stat-group {
  background: #f8fafd;
  border-radius: 12px;
  padding: 18px 12px 12px 12px;
  /* flex: 1 1 240px; */
  margin: 0 8px;
  box-shadow: 0 2px 8px rgba(64,158,255,0.08);
  min-width: 200px;
}
.stat-group-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.stat-group-icon {
  font-size: 20px;
}
.node-icon {
  color: #67c23a;
}
.relation-icon {
  color: #e6a23c;
}
.stat-items {
  display: flex;
  justify-content: space-around;
  gap: 18px;
  padding: 10px 0;
  flex-wrap: wrap;
}
.stat-item {
  text-align: center;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 1px 4px rgba(64,158,255,0.04);
  padding: 10px 12px;
  min-width: 70px;
  margin-bottom: 8px;
}
.node-item .stat-value {
  color: #67c23a;
}
.relation-item .stat-value {
  color: #e6a23c;
}
.stat-value {
  font-size: 32px;
  font-weight: bold;
}
.stat-label {
  margin-top: 8px;
  font-size: 13px;
  color: #606266;
}
/* @media (max-width: 900px) {
  .dashboard-row {
    flex-direction: column !important;
  }
  .stat-items-flex {
    flex-direction: column;
    gap: 18px;
  }
  .stat-group {
    margin: 0 0 16px 0;
    min-width: unset;
  }
}
@media (max-width: 600px) {
  .dashboard-row {
    flex-direction: column !important;
  }
  .stat-items-flex {
    flex-direction: column;
    gap: 12px;
  }
  .stat-group {
    margin: 0 0 12px 0;
    padding: 12px 6px 8px 6px;
  }
  .stat-item {
    min-width: 50px;
    padding: 6px 4px;
  }
  .stat-value {
    font-size: 22px;
  }
} */
</style>